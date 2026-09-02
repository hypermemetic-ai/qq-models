// openai-codex adapter. ChatGPT backend Responses with this plugin's store.
// Feature floor is Pi's openai-codex-responses path: SSE, function tools,
// encrypted-reasoning replay, session cache key, effort, and 401 refresh.
// DSH still owns tool execution. Honest qq identity; no hosted search tools.

import { CODEX } from "./connectors.mjs";
import { internals as oauthInternals, refreshCodexToken, userAgent } from "./oauth.mjs";
import {
  ResponsesLlmError,
  chunksFromEvents as sharedChunksFromEvents,
  classifyResponsesFailure,
  effortList,
  iterateSse,
  readSse,
  providerFailureDetails,
  redact,
  requestBody as sharedRequestBody,
  streamWithRetry,
  toResponsesInput as sharedToResponsesInput,
  toResponsesTools as sharedToResponsesTools,
} from "./responses.mjs";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_REPLAY_KIND = "openai-codex";
export const CODEX_MODEL = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  contextWindow: 272_000,
  maxTokens: 128_000,
  input: Object.freeze(["text", "image"]),
  // Public gpt-5.6-sol efforts: https://developers.openai.com/api/docs/models/gpt-5.6-sol
  reasoning: Object.freeze({
    efforts: effortList(["off", "low", "medium", "high", ["xhigh", "extra high"], "max"]),
    defaultEffort: "xhigh",
  }),
};

const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
]);

export class CodexLlmError extends ResponsesLlmError {
  constructor(message, code, options = {}) {
    super(message, code, { ...options, name: "CodexLlmError" });
  }
}

export const classifyCodexFailure = classifyResponsesFailure;

export function toResponsesTools(tools) {
  return sharedToResponsesTools(tools, CodexLlmError);
}

export function toResponsesInput(messages, system) {
  return sharedToResponsesInput(messages, system, { replayKind: CODEX_REPLAY_KIND });
}

export function requestBody(options) {
  return sharedRequestBody(options, {
    replayKind: CODEX_REPLAY_KIND,
    ErrorClass: CodexLlmError,
    instructionsFallback: "You are a helpful assistant.",
    // OpenAI's wire name is `none`; DSH/qq call that `off`.
    reasoningMap: { off: "none" },
  });
}

export function mapCodexEvent(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
    const response = event.response;
    return {
      ...event,
      type: "response.completed",
      response: response
        ? {
          ...response,
          status: CODEX_RESPONSE_STATUSES.has(response.status) ? response.status : undefined,
        }
        : response,
    };
  }
  return event;
}

export function mapCodexEvents(events) {
  const mapped = [];
  for (const event of events) {
    const type = typeof event?.type === "string" ? event.type : "";
    mapped.push(mapCodexEvent(event));
    if (type === "response.done" || type === "response.completed" || type === "response.incomplete") break;
  }
  return mapped;
}

export function chunksFromEvents(events) {
  return sharedChunksFromEvents(events, { replayKind: CODEX_REPLAY_KIND, mapEvent: mapCodexEvent });
}

function accountIdOf(auth) {
  if (typeof auth?.accountId === "string" && auth.accountId.length > 0) return auth.accountId;
  const accountId = oauthInternals.decodeJwt(auth?.access)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.length > 0) return accountId;
  throw new CodexLlmError("Codex token did not include an account id", "INVALID_CREDENTIAL");
}

export function codexHeaders(auth, sessionId) {
  const requestId = typeof sessionId === "string" && sessionId.trim() !== "" ? sessionId : undefined;
  return {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.access}`,
    "User-Agent": userAgent(),
    "chatgpt-account-id": accountIdOf(auth),
    originator: "qq",
    "OpenAI-Beta": "responses=experimental",
    ...requestId === undefined ? {} : {
      "session-id": requestId,
      "x-client-request-id": requestId,
    },
  };
}

export function createCodexAdapter({
  store,
  fetchImpl = fetch,
  now = Date.now,
  sleepFn,
} = {}) {
  async function authorizedToken(forceRefresh = false) {
    if (forceRefresh) {
      return store.rotate(CODEX, (current) => refreshCodexToken(current, { fetchImpl, now }));
    }
    return store.accessToken(CODEX, (current) => refreshCodexToken(current, { fetchImpl, now }));
  }

  async function postOnce(options, token, body) {
    let response;
    try {
      response = await fetchImpl(CODEX_URL, {
        method: "POST",
        headers: codexHeaders(token, options.sessionId),
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new CodexLlmError("codex request aborted by caller", "ABORTED", { cause: error });
      throw Object.assign(new Error(redact(error?.message ?? "Responses failed")), { status: undefined });
    }
    if (!response.ok) {
      const raw = redact(await response.text().catch(() => response.statusText));
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const upstream = parsed?.error && typeof parsed.error === "object" ? parsed.error : {};
      const failure = providerFailureDetails({
        type: "error",
        status: response.status,
        request_id: response.headers?.get?.("x-request-id")
          ?? response.headers?.get?.("request-id")
          ?? response.headers?.get?.("cf-ray"),
        error: {
          code: upstream.code ?? upstream.type,
          message: upstream.message ?? raw ?? response.statusText,
        },
      });
      throw Object.assign(new Error(failure.message), failure);
    }
    return iterateSse(response, options.signal);
  }

  return {
    lastRequest: undefined,
    providerInfo(provider) {
      return { id: provider, name: "OpenAI Codex (qq)" };
    },
    providerRetryPolicy() {
      return undefined;
    },
    listModels(provider) {
      return Promise.resolve([{
        provider,
        id: CODEX_MODEL.id,
        name: CODEX_MODEL.name,
        inputModalities: [...CODEX_MODEL.input],
      }]);
    },
    resolveModel(provider, model) {
      return Promise.resolve({
        provider,
        id: model,
        name: model === CODEX_MODEL.id ? CODEX_MODEL.name : model,
        inputModalities: [...CODEX_MODEL.input],
        context: { contextWindow: CODEX_MODEL.contextWindow },
        defaultMaxTokens: CODEX_MODEL.maxTokens,
        reasoning: CODEX_MODEL.reasoning,
      });
    },
    imageRequestPricing() {
      return undefined;
    },
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: (options) => this.stream(options),
      };
    },
    async *stream(options) {
      this.lastRequest = undefined;
      const body = requestBody(options);
      this.lastRequest = {
        url: CODEX_URL,
        model: options.model,
        hasAuthorization: true,
      };
      yield* streamWithRetry({
        options,
        body,
        authorizedToken,
        postOnce,
        toChunks: chunksFromEvents,
        ErrorClass: CodexLlmError,
        abortMessage: "codex request aborted by caller",
        replayKind: CODEX_REPLAY_KIND,
        mapEvent: mapCodexEvent,
        ...sleepFn === undefined ? {} : { sleepFn },
      });
    },
  };
}

export const internals = Object.freeze({
  classifyCodexFailure,
  redact,
  toResponsesInput,
  toResponsesTools,
  requestBody,
  chunksFromEvents,
  mapCodexEvents,
  codexHeaders,
});
