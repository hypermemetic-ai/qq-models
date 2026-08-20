// xai-auth adapter. Session proxy Responses, honest qq identity, three failure classes.
// Duck-typed LlmAdapter so this file loads without the DSH toolchain.
//
// DSH tools are advertised as Responses function tools under their DSH names.
// This adapter does not remap names and does not inject hosted/native tools.
// DSH still owns tool execution and the agent loop.

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
    this.failure = Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
    });
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
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) return "transport";
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

function toolResultText(block) {
  if (typeof block?.content === "string") return block.content;
  return (Array.isArray(block?.content) ? block.content : [])
    .map((part) => (part?.type === "text" ? part.text : ""))
    .join("");
}

function messageText(block) {
  return typeof block?.text === "string" ? block.text : "";
}

/** Map DSH tool schemas to Responses function tools. Names pass through unchanged. */
export function toResponsesTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Convert DSH messages into Responses `instructions` + `input` items.
 * `options.system` (and system-role history) become top-level `instructions`.
 * Images and reasoning are skipped; this adapter does not invent vision.
 */
export function toResponsesInput(messages, system) {
  const input = [];
  const systemTexts = [];
  for (const message of messages ?? []) {
    if (message.role === "system") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "text") systemTexts.push(messageText(block));
        }
      } else if (message.content != null) {
        systemTexts.push(String(message.content));
      }
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    if (!Array.isArray(message.content)) {
      const text = String(message.content ?? "");
      input.push({
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      });
      continue;
    }
    let content = [];
    const flushMessage = () => {
      if (content.length === 0) return;
      input.push({ type: "message", role, content });
      content = [];
    };
    for (const block of message.content) {
      switch (block?.type) {
        case "text":
          content.push({ type: role === "assistant" ? "output_text" : "input_text", text: messageText(block) });
          break;
        case "tool-call":
          flushMessage();
          input.push({
            type: "function_call",
            call_id: String(block.id ?? ""),
            name: block.name,
            arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {}),
          });
          break;
        case "tool-result":
          flushMessage();
          input.push({
            type: "function_call_output",
            call_id: String(block.toolCallId ?? ""),
            output: toolResultText(block),
          });
          break;
        default:
          // image, reasoning, unknown: skip. No vision, no name remapping.
          break;
      }
    }
    flushMessage();
  }
  const instructions = system || (systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined);
  return { ...instructions ? { instructions } : {}, input };
}

export function requestBody(options) {
  const { instructions, input } = toResponsesInput(options.messages, options.system);
  const tools = toResponsesTools(options.tools);
  return {
    model: options.model,
    stream: true,
    store: false,
    ...instructions === undefined ? {} : { instructions },
    input,
    include: ["reasoning.encrypted_content"],
    ...tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {},
  };
}

function proxyHeaders(token, modelId, sessionId) {
  const requestId = randomUUID();
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": userAgent(),
    "x-grok-client-identifier": PACKAGE_IDENTITY.product,
    "x-grok-client-version": PACKAGE_IDENTITY.grokClientVersion,
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

function mapResponsesUsage(usage) {
  const cached = usage.input_tokens_details?.cached_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens - (cached ?? 0),
    outputTokens: usage.output_tokens,
    ...cached !== undefined ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  };
}

function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return {
        type: "tool-call",
        id: block.callId,
        name: block.name ?? "",
        arguments: block.text,
      };
    default:
      return { type: "text", text: block.text };
  }
}

/** Responses SSE → DSH StreamChunk. Fake XML in text is never promoted to a tool call. */
class ResponsesStreamTranslator {
  constructor() {
    this.blocks = new Map();
    this.order = [];
    this.nextIndex = 0;
    this.sawToolCall = false;
    this.sawResponses = false;
    this.terminated = false;
    this.chunks = [];
  }

  open(key, kind, callId = "", name) {
    const block = {
      index: this.nextIndex++,
      kind,
      text: "",
      callId,
      ...name === undefined ? {} : { name },
    };
    this.blocks.set(key, block);
    this.order.push(block);
    this.chunks.push({ type: "block-start", index: block.index, blockType: kind });
    return block;
  }

  textBlock(key) {
    return this.blocks.get(key) ?? this.open(key, "text");
  }

  reasoningBlock(key) {
    return this.blocks.get(key) ?? this.open(key, "reasoning");
  }

  close(key) {
    const block = this.blocks.get(key);
    if (block === undefined) return;
    this.blocks.delete(key);
    this.chunks.push({ type: "block-end", index: block.index, block: closeBlock(block) });
  }

  closeItem(itemId) {
    for (const key of [...this.blocks.keys()]) {
      if (key.startsWith(`${itemId}:`)) this.close(key);
    }
  }

  closeAll() {
    for (const block of this.order) {
      for (const [key, candidate] of this.blocks) {
        if (candidate === block) {
          this.blocks.delete(key);
          this.chunks.push({ type: "block-end", index: block.index, block: closeBlock(block) });
          break;
        }
      }
    }
  }

  finishReason(kind, failure) {
    this.terminated = true;
    this.closeAll();
    this.chunks.push({
      type: "finish",
      reason: failure ? { kind, failure } : { kind },
    });
  }

  push(event) {
    this.sawResponses = true;
    if (this.terminated) return;
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item;
        if (item?.type === "function_call" && item.id !== undefined) {
          this.sawToolCall = true;
          const callId = item.call_id ?? "";
          const block = this.open(`${item.id}:call`, "tool-call", callId, item.name);
          this.chunks.push({
            type: "tool-call-delta",
            index: block.index,
            id: callId,
            ...item.name === undefined ? {} : { name: item.name },
            argumentsDelta: "",
          });
        }
        return;
      }
      case "response.output_text.delta": {
        const key = `${event.item_id ?? ""}:text:${String(event.content_index ?? 0)}`;
        const block = this.textBlock(key);
        const delta = event.delta ?? "";
        block.text += delta;
        this.chunks.push({ type: "text-delta", index: block.index, text: delta });
        return;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const sub = event.summary_index ?? event.content_index ?? 0;
        const key = `${event.item_id ?? ""}:reason:${String(sub)}`;
        const block = this.reasoningBlock(key);
        const delta = event.delta ?? "";
        block.text += delta;
        this.chunks.push({ type: "reasoning-delta", index: block.index, text: delta });
        return;
      }
      case "response.function_call_arguments.delta": {
        const key = `${event.item_id ?? ""}:call`;
        let block = this.blocks.get(key);
        if (block === undefined) {
          this.sawToolCall = true;
          block = this.open(key, "tool-call");
        }
        const delta = event.delta ?? "";
        block.text += delta;
        this.chunks.push({
          type: "tool-call-delta",
          index: block.index,
          id: block.callId,
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: delta,
        });
        return;
      }
      case "response.output_item.done": {
        const item = event.item;
        if (item === undefined || item.id === undefined) return;
        if (item.type === "function_call") {
          const key = `${item.id}:call`;
          let block = this.blocks.get(key);
          if (block === undefined) {
            this.sawToolCall = true;
            block = this.open(key, "tool-call", item.call_id ?? "", item.name);
          }
          if (item.call_id) block.callId = item.call_id;
          if (item.name) block.name = item.name;
          if (block.text.length === 0 && item.arguments !== undefined) block.text = item.arguments;
          this.close(key);
        } else if (item.type === "message") {
          if (![...this.blocks.keys()].some((key) => key.startsWith(`${item.id}:text:`))) {
            for (const [partIndex, part] of (item.content ?? []).entries()) {
              if (part?.type !== "output_text" || typeof part.text !== "string" || part.text.length === 0) continue;
              const key = `${item.id}:text:${partIndex}`;
              const block = this.open(key, "text");
              block.text = part.text;
              this.close(key);
            }
          }
          this.closeItem(item.id);
        } else {
          this.closeItem(item.id);
        }
        return;
      }
      case "response.completed": {
        this.closeAll();
        const usage = event.response?.usage;
        if (usage !== undefined) this.chunks.push({ type: "usage", usage: mapResponsesUsage(usage) });
        this.finishReason(this.sawToolCall ? "tool-calls" : "stop");
        return;
      }
      case "response.failed":
      case "error":
        this.finishReason("error", {
          message: redact(event.response?.error?.message ?? event.message ?? "the provider reported a failed response"),
          code: "PROVIDER",
        });
        return;
      case "response.incomplete":
        this.finishReason("error", {
          message: redact(
            event.response?.error?.message
              ?? `the provider reported an incomplete response (${event.response?.incomplete_details?.reason ?? "unknown reason"})`,
          ),
          code: "PROVIDER",
        });
        return;
      default:
        return;
    }
  }

  finish() {
    if (!this.terminated) this.finishReason(this.sawToolCall ? "tool-calls" : "stop");
    return this.chunks;
  }
}

function legacyTextChunks(events) {
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

export function chunksFromEvents(events) {
  const translator = new ResponsesStreamTranslator();
  const legacy = [];
  for (const event of events) {
    const type = typeof event?.type === "string" ? event.type : "";
    if (type.startsWith("response.") || type === "error") translator.push(event);
    else legacy.push(event);
  }
  if (translator.sawResponses) return translator.finish();
  return legacyTextChunks(legacy);
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
    const body = requestBody(options);
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
  toInput: (messages, system) => toResponsesInput(messages, system).input,
  toResponsesInput,
  toResponsesTools,
  requestBody,
  chunksFromEvents,
  proxyHeaders,
});
