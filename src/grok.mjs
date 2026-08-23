// xai-auth adapter. Session proxy Responses, honest qq identity, three failure classes.
// Duck-typed LlmAdapter so this file loads without the DSH toolchain.
//
// DSH tools are advertised as Responses function tools under their DSH names.
// This adapter does not remap names and does not inject hosted/native tools.
// DSH still owns tool execution and the agent loop.

import { randomUUID } from "node:crypto";

import { GROK } from "./connectors.mjs";
import { inputImagePart, loadInputImages, toolResultImages } from "./input-images.mjs";
import { PACKAGE_IDENTITY, refreshGrokToken, userAgent } from "./oauth.mjs";
import {
  ResponsesLlmError,
  chunksFromEvents as sharedChunksFromEvents,
  classifyResponsesFailure,
  effortList,
  readSse,
  redact as sharedRedact,
  requestBody as sharedRequestBody,
  streamWithRetry,
  toResponsesInput as sharedToResponsesInput,
  toResponsesTools as sharedToResponsesTools,
  normalizeToolParameters as sharedNormalizeToolParameters,
} from "./responses.mjs";

export const GROK_PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses";
export const GROK_REPLAY_KIND = "xai-auth";
export const GROK_MODEL = {
  id: "grok-4.6",
  name: "Grok 4.6",
  contextWindow: 200_000,
  maxTokens: 64_000,
  input: Object.freeze(["text"]),
  // Public grok-4.6 efforts: https://docs.x.ai/developers/model-capabilities/text/reasoning
  reasoning: Object.freeze({
    efforts: effortList(["low", "medium", "high", ["xhigh", "extra high"]]),
    defaultEffort: "high",
  }),
};

export class GrokLlmError extends ResponsesLlmError {
  constructor(message, code, options = {}) {
    super(message, code, { ...options, name: "GrokLlmError" });
  }
}

export const classifyGrokFailure = classifyResponsesFailure;
export const redact = sharedRedact;

export function normalizeToolParameters(parameters, index = 0) {
  return sharedNormalizeToolParameters(parameters, index, GrokLlmError);
}

export function toResponsesTools(tools) {
  return sharedToResponsesTools(tools, GrokLlmError);
}

export function toResponsesInput(messages, system) {
  return sharedToResponsesInput(messages, system, { replayKind: GROK_REPLAY_KIND });
}

export function requestBody(options) {
  return sharedRequestBody(options, {
    replayKind: GROK_REPLAY_KIND,
    ErrorClass: GrokLlmError,
    // xAI cannot disable reasoning. grok-4.6 has no `max`; xhigh is its own highest level.
    reasoningMap: { off: null, minimal: null, none: null },
  });
}

export function chunksFromEvents(events) {
  return sharedChunksFromEvents(events, { replayKind: GROK_REPLAY_KIND });
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

export function createGrokAdapter({
  store,
  fetchImpl = fetch,
  now = Date.now,
  sleepFn,
} = {}) {
  async function authorizedToken(forceRefresh = false) {
    if (forceRefresh) {
      return store.rotate(GROK, (current) => refreshGrokToken(current, { fetchImpl, now }));
    }
    return store.accessToken(GROK, (current) => refreshGrokToken(current, { fetchImpl, now }));
  }

  async function postOnce(options, token, body) {
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
        reasoning: GROK_MODEL.reasoning,
      });
    },
    async *stream(options) {
      this.lastRequest = undefined;
      const body = requestBody(options);
      this.lastRequest = {
        url: GROK_PROXY_URL,
        model: options.model,
        hasAuthorization: true,
      };
      yield* streamWithRetry({
        options,
        body,
        authorizedToken,
        postOnce,
        toChunks: chunksFromEvents,
        ErrorClass: GrokLlmError,
        abortMessage: "grok request aborted by caller",
        ...sleepFn === undefined ? {} : { sleepFn },
      });
    },
  };
}

export const internals = Object.freeze({
  classifyGrokFailure,
  redact,
  toInput: (messages, system) => toResponsesInput(messages, system).input,
  toResponsesInput,
  normalizeToolParameters,
  toResponsesTools,
  requestBody,
  chunksFromEvents,
  proxyHeaders,
});
