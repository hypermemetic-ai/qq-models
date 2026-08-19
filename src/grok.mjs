// xai-auth adapter. Session proxy Responses, honest qq identity, three failure classes.
// Duck-typed LlmAdapter so this file loads without the DSH toolchain.

import { randomUUID } from "node:crypto";

import { GROK } from "./connectors.mjs";
import { PACKAGE_IDENTITY, refreshGrokToken, userAgent } from "./oauth.mjs";

export const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses";
export const GROK_MODEL = {
  id: "grok-4.6",
  name: "Grok 4.6",
  contextWindow: 200_000,
  maxTokens: 64_000,
  input: Object.freeze(["text"]),
};

const TRANSPORT_TRIES = 3;
const TRANSPORT_BACKOFF_MS = Object.freeze([150, 400]);

export class GrokLlmError extends Error {
  constructor(message, code, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GrokLlmError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function httpStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = String(error?.message ?? "").match(/\b(40\d|42\d|50\d)\b/);
  return match ? Number(match[1]) : undefined;
}

export function classifyGrokFailure(error) {
  const status = httpStatus(error);
  if (status === 401) return "auth";
  if (status === 400 || status === 422) return "reject";
  if (status === undefined) return "transport";
  return "other";
}

export function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
}

function asError(error, code = "PROVIDER") {
  if (error instanceof GrokLlmError) return error;
  const status = httpStatus(error);
  return new GrokLlmError(redact(error?.message ?? error), code, status === undefined ? {} : { status });
}

function toInput(messages, system) {
  const input = [];
  if (system) input.push({ role: "system", content: [{ type: "input_text", text: system }] });
  for (const message of messages ?? []) {
    const text = Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("")
      : String(message.content ?? "");
    input.push({
      role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text }],
    });
  }
  return input;
}

function proxyHeaders(token, modelId, sessionId) {
  const requestId = randomUUID();
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": userAgent(),
    "x-grok-client-identifier": PACKAGE_IDENTITY.product,
    "x-grok-client-version": PACKAGE_IDENTITY.version,
    "x-grok-client-mode": "headless",
    "x-grok-conv-id": sessionId || requestId,
    "x-grok-req-id": requestId,
    "x-grok-session-id": sessionId || requestId,
    "x-grok-model-override": modelId,
  };
}

function parseSseText(text) {
  const events = [];
  for (const part of String(text).split("\n\n")) {
    const dataLines = part.split("\n").filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); }
      catch { events.push({ type: "text", text: trimmed }); }
      continue;
    }
    const payload = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); }
    catch { events.push({ type: "text", text: payload }); }
  }
  return events;
}

async function readSse(response, signal) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return parseSseText(await response.text());
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) events.push(...parseSseText(part));
    }
    if (buffer.trim()) events.push(...parseSseText(buffer));
  } finally {
    try { await reader.cancel(); } catch { /* closed */ }
  }
  return events;
}

function chunksFromEvents(events) {
  const text = events.flatMap((event) => {
    if (typeof event?.delta === "string") return [event.delta];
    if (typeof event?.text === "string") return [event.text];
    const output = event?.response?.output ?? event?.output;
    if (Array.isArray(output)) {
      return output.flatMap((item) => (item?.content ?? []).map((block) => block?.text).filter(Boolean));
    }
    return [];
  }).join("");
  if (!text) return [{ type: "finish", reason: { kind: "stop" } }];
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

export function createGrokAdapter({
  store,
  fetchImpl = fetch,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  async function authorizedToken(forceRefresh = false) {
    if (forceRefresh) {
      return store.rotate(GROK, (current) => refreshGrokToken(current, { fetchImpl, now }));
    }
    return store.accessToken(GROK, (current) => refreshGrokToken(current, { fetchImpl, now }));
  }

  async function postOnce(options, token) {
    const body = {
      model: options.model,
      stream: true,
      store: false,
      input: toInput(options.messages, options.system),
      include: ["reasoning.encrypted_content"],
    };
    let response;
    try {
      response = await fetchImpl(GROK_PROXY_URL, {
        method: "POST",
        headers: proxyHeaders(token.access, options.model, options.sessionId),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new GrokLlmError("grok request aborted by caller", "ABORTED", { cause: error });
      throw Object.assign(new Error(redact(error?.message ?? "Responses failed")), { status: undefined });
    }
    if (!response.ok) {
      const detail = redact(await response.text().catch(() => response.statusText));
      throw Object.assign(new Error(`Responses failed (${response.status})${detail ? `: ${detail}` : ""}`), {
        status: response.status,
      });
    }
    return readSse(response, options.signal);
  }

  return {
    lastRequest: undefined,
    providerInfo(provider) {
      return { id: provider, name: "xAI Grok (qq)" };
    },
    providerRetryPolicy() {
      return undefined;
    },
    listModels(provider) {
      return Promise.resolve([{
        provider,
        id: GROK_MODEL.id,
        name: GROK_MODEL.name,
        inputModalities: [...GROK_MODEL.input],
      }]);
    },
    resolveModel(provider, model) {
      return Promise.resolve({
        provider,
        id: model,
        name: model === GROK_MODEL.id ? GROK_MODEL.name : model,
        inputModalities: [...GROK_MODEL.input],
        context: { contextWindow: GROK_MODEL.contextWindow },
        defaultMaxTokens: GROK_MODEL.maxTokens,
      });
    },
    async *stream(options) {
      this.lastRequest = undefined;
      let token = await authorizedToken(false);
      let refreshed = false;
      let transportTries = 0;
      for (;;) {
        try {
          this.lastRequest = {
            url: GROK_PROXY_URL,
            model: options.model,
            hasAuthorization: true,
          };
          const events = await postOnce(options, token);
          for (const chunk of chunksFromEvents(events)) yield chunk;
          return;
        } catch (error) {
          if (options.signal?.aborted) throw new GrokLlmError("grok request aborted by caller", "ABORTED", { cause: error });
          const kind = classifyGrokFailure(error);
          if (kind === "auth" && !refreshed) {
            token = await authorizedToken(true);
            refreshed = true;
            continue;
          }
          if (kind === "transport" && transportTries < TRANSPORT_TRIES - 1) {
            await sleepFn(TRANSPORT_BACKOFF_MS[transportTries] ?? 400, options.signal);
            transportTries += 1;
            continue;
          }
          if (kind === "reject") throw asError(error, "INVALID_REQUEST");
          if (kind === "auth") throw asError(error, "INVALID_CREDENTIAL");
          throw asError(error, "PROVIDER");
        }
      }
    },
  };
}

export const internals = Object.freeze({
  classifyGrokFailure,
  redact,
  toInput,
  proxyHeaders,
});
