// Shared OpenAI Responses translation for Grok and Codex. DSH owns the loop;
// this module maps tools, history, SSE, usage, and encrypted-reasoning replay.

export class ResponsesLlmError extends Error {
  constructor(message, code, { status, cause, name, providerCode, responseId, requestId } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = name ?? "ResponsesLlmError";
    this.code = code;
    if (status !== undefined) this.status = status;
    if (providerCode !== undefined) this.providerCode = providerCode;
    if (responseId !== undefined) this.responseId = responseId;
    if (requestId !== undefined) this.requestId = requestId;
    this.failure = Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerCode === undefined ? {} : { providerCode },
      ...responseId === undefined ? {} : { responseId },
      ...requestId === undefined ? {} : { requestId },
    });
  }
}

export function httpStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  const match = String(error?.message ?? "").match(/\b(40\d|42\d|50\d)\b/);
  return match ? Number(match[1]) : undefined;
}

export function classifyResponsesFailure(error) {
  const status = httpStatus(error);
  const providerCode = String(error?.providerCode ?? "").toLowerCase();
  if (status === 401 || /(?:auth|unauthor|token|credential)/.test(providerCode)) return "auth";
  if (status === 400 || status === 422
    || /(?:invalid|context_length|content_filter|content_policy|unsupported|malformed)/.test(providerCode)) return "reject";
  if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500
    || /(?:rate|server|timeout|overload|internal|temporar|unavailable)/.test(providerCode)) return "transport";
  return "other";
}

export function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]");
}

function boundedDiagnostic(value, max = 1_000) {
  const text = redact(value).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function diagnosticId(value) {
  const text = boundedDiagnostic(value, 160);
  return text && /^[A-Za-z0-9._:-]+$/.test(text) ? text : undefined;
}

function numericStatus(...values) {
  return values.find((value) => Number.isInteger(value) && value >= 100 && value <= 599);
}

/** Safe, bounded diagnostics from one terminal Responses event or HTTP failure. */
export function providerFailureDetails(event = {}) {
  const response = event.response && typeof event.response === "object" ? event.response : {};
  const error = response.error && typeof response.error === "object"
    ? response.error
    : event.error && typeof event.error === "object" ? event.error : {};
  const providerCode = diagnosticId(error.code ?? error.type ?? event.code);
  const responseId = diagnosticId(response.id ?? event.response_id);
  const requestId = diagnosticId(event.request_id ?? response.request_id);
  const status = numericStatus(error.status, error.status_code, response.status_code, event.status, event.status_code);
  const detail = boundedDiagnostic(error.message ?? event.message ?? "the provider reported a failed response");
  const labels = [
    status === undefined ? undefined : `http_status=${status}`,
    providerCode === undefined ? undefined : `provider_code=${providerCode}`,
    responseId === undefined ? undefined : `response_id=${responseId}`,
    requestId === undefined ? undefined : `request_id=${requestId}`,
  ].filter(Boolean);
  const message = `Responses failed${labels.length > 0 ? ` (${labels.join(", ")})` : ""}${detail ? `: ${detail}` : ""}`;
  return Object.freeze({
    message,
    ...status === undefined ? {} : { status },
    ...providerCode === undefined ? {} : { providerCode },
    ...responseId === undefined ? {} : { responseId },
    ...requestId === undefined ? {} : { requestId },
  });
}

export function responseEventError(event, ErrorClass = ResponsesLlmError) {
  const type = typeof event?.type === "string" ? event.type : "";
  if (type !== "response.failed" && type !== "error") return undefined;
  const failure = providerFailureDetails(event);
  return new ErrorClass(failure.message, "PROVIDER", failure);
}

export function sleep(ms, signal) {
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

export const TRANSPORT_TRIES = 3;
export const TRANSPORT_BACKOFF_MS = Object.freeze([750, 2_000]);

function isNonArrayObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneSchemaValue(value) {
  if (Array.isArray(value)) return value.map(cloneSchemaValue);
  if (!isNonArrayObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneSchemaValue(child)]),
  );
}

function invalidToolSchema(index, detail, ErrorClass) {
  return new ErrorClass(
    `tool schema at index ${index} is invalid: ${detail}`,
    "INVALID_TOOL_SCHEMA",
  );
}

/**
 * Normalize DSH's flat parameter map into the object-root JSON Schema required
 * by Responses. Full object schemas are cloned without semantic changes.
 */
export function normalizeToolParameters(parameters, index = 0, ErrorClass = ResponsesLlmError) {
  if (!isNonArrayObject(parameters)) {
    throw invalidToolSchema(index, "parameters must be a non-array object", ErrorClass);
  }
  if (Object.hasOwn(parameters, "type") && parameters.type === "object") {
    return cloneSchemaValue(parameters);
  }

  const properties = {};
  const required = [];
  for (const [name, sourceSchema] of Object.entries(parameters)) {
    if (!isNonArrayObject(sourceSchema)) {
      throw invalidToolSchema(index, "each flat parameter must have an object schema", ErrorClass);
    }
    const schema = cloneSchemaValue(sourceSchema);
    if (typeof schema.required === "boolean") {
      if (schema.required) required.push(name);
      delete schema.required;
    }
    properties[name] = schema;
  }
  return {
    type: "object",
    properties,
    ...required.length > 0 ? { required } : {},
  };
}

/** Map DSH tool schemas to Responses function tools. Names pass through unchanged. */
export function toResponsesTools(tools, ErrorClass = ResponsesLlmError) {
  if (tools == null) return [];
  if (!Array.isArray(tools)) {
    throw new ErrorClass("tools are invalid: expected an array", "INVALID_TOOL_SCHEMA");
  }
  return tools.map((tool, index) => {
    if (!isNonArrayObject(tool)) throw invalidToolSchema(index, "tool must be an object", ErrorClass);
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolParameters(tool.parameters, index, ErrorClass),
    };
  });
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

function reasoningReplayBlocks(message, replayKind) {
  const state = message?.source?.replayState;
  if (!state || state.response?.kind !== replayKind || !Array.isArray(state.blocks)) return undefined;
  return state.blocks;
}

function isReasoningReplayItem(entry) {
  return entry !== null && typeof entry === "object"
    && entry.type === "reasoning"
    && typeof entry.encrypted_content === "string" && entry.encrypted_content.length > 0;
}

/**
 * Convert DSH messages into Responses `instructions` + `input` items.
 * Reasoning is replayed from adapter-private replayState (encrypted_content).
 * Images are skipped unless a later adapter learns the attachment store.
 */
export function toResponsesInput(messages, system, { replayKind } = {}) {
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
    const replayBlocks = replayKind ? reasoningReplayBlocks(message, replayKind) : undefined;
    let content = [];
    const flushMessage = () => {
      if (content.length === 0) return;
      input.push({ type: "message", role, content });
      content = [];
    };
    for (const [index, block] of message.content.entries()) {
      switch (block?.type) {
        case "text":
          content.push({ type: role === "assistant" ? "output_text" : "input_text", text: messageText(block) });
          break;
        case "reasoning": {
          const replay = replayBlocks?.[index];
          if (isReasoningReplayItem(replay)) {
            flushMessage();
            input.push(replay);
          }
          break;
        }
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
          break;
      }
    }
    flushMessage();
  }
  const instructions = system || (systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined);
  return { ...instructions ? { instructions } : {}, input };
}

export function reasoningBody(effort, { wire = {}, summary = "auto" } = {}) {
  if (effort == null || effort === "") return undefined;
  const mapped = Object.hasOwn(wire, effort) ? wire[effort] : effort;
  if (mapped == null) return undefined;
  return { reasoning: { effort: mapped, summary } };
}

export function requestBody(options, {
  replayKind,
  ErrorClass = ResponsesLlmError,
  extra = {},
  instructionsFallback,
  reasoningMap,
} = {}) {
  const converted = toResponsesInput(options.messages, options.system, { replayKind });
  const instructions = converted.instructions ?? instructionsFallback;
  const tools = toResponsesTools(options.tools, ErrorClass);
  const sessionId = typeof options.sessionId === "string" && options.sessionId.trim() !== "" ? options.sessionId : undefined;
  const reasoning = reasoningBody(options.reasoningEffort, { wire: reasoningMap });
  return {
    model: options.model,
    stream: true,
    store: false,
    ...(sessionId === undefined ? {} : { prompt_cache_key: sessionId }),
    ...instructions === undefined ? {} : { instructions },
    input: converted.input,
    include: ["reasoning.encrypted_content"],
    ...tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {},
    ...reasoning === undefined ? {} : reasoning,
    ...extra,
  };
}

export function parseSseText(text) {
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

export async function* iterateSse(response, signal) {
  if (!response.body || typeof response.body.getReader !== "function") {
    for (const event of parseSseText(await response.text())) yield event;
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        for (const event of parseSseText(part)) yield event;
      }
    }
    if (buffer.trim()) {
      for (const event of parseSseText(buffer)) yield event;
    }
  } finally {
    try { await reader.cancel(); } catch { /* closed */ }
  }
}

export async function readSse(response, signal) {
  const events = [];
  for await (const event of iterateSse(response, signal)) events.push(event);
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

function reasoningReplayItem(item) {
  if (typeof item?.encrypted_content !== "string" || item.encrypted_content.length === 0) return undefined;
  return {
    type: "reasoning",
    ...(item.id === undefined ? {} : { id: item.id }),
    summary: [],
    encrypted_content: item.encrypted_content,
  };
}

/** Responses SSE → DSH StreamChunk. Fake XML in text is never promoted to a tool call. */
class ResponsesStreamTranslator {
  constructor(replayKind) {
    this.replayKind = replayKind;
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
    const replayState = failure ? undefined : this.replayState();
    this.chunks.push({
      type: "finish",
      reason: failure ? { kind, failure } : { kind },
      ...(replayState === undefined ? {} : { replayState }),
    });
  }

  replayState() {
    const blocks = this.order.map((block) => block.replay ?? null);
    if (!blocks.some((entry) => entry !== null)) return undefined;
    return { response: { kind: this.replayKind, version: 1 }, blocks };
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
        const key = `${event.item_id ?? ""}:reason`;
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
        } else if (item.type === "reasoning") {
          const key = `${item.id}:reason`;
          let block = this.blocks.get(key);
          if (block === undefined) block = this.open(key, "reasoning");
          const replay = reasoningReplayItem(item);
          if (replay !== undefined) block.replay = replay;
          this.close(key);
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
      case "error": {
        const failure = providerFailureDetails(event);
        this.finishReason("error", { message: failure.message, code: "PROVIDER" });
        return;
      }
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
    if (typeof event?.output_text === "string") return [event.output_text];
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

export function createResponsesTranslator({ replayKind, mapEvent } = {}) {
  const translator = new ResponsesStreamTranslator(replayKind);
  const legacy = [];
  let emitted = 0;
  const drain = () => {
    const next = translator.chunks.slice(emitted);
    emitted = translator.chunks.length;
    return next;
  };
  return {
    push(raw) {
      const event = mapEvent ? mapEvent(raw) : raw;
      if (event == null) return [];
      const type = typeof event?.type === "string" ? event.type : "";
      if (type.startsWith("response.") || type === "error") translator.push(event);
      else legacy.push(event);
      return drain();
    },
    finish() {
      if (translator.sawResponses) {
        translator.finish();
        return drain();
      }
      return legacyTextChunks(legacy);
    },
  };
}

export function chunksFromEvents(events, { replayKind, mapEvent } = {}) {
  const translator = createResponsesTranslator({ replayKind, mapEvent });
  const chunks = [];
  for (const event of events) chunks.push(...translator.push(event));
  chunks.push(...translator.finish());
  return chunks;
}

export function asResponsesError(error, code, ErrorClass) {
  if (error instanceof ErrorClass && error.code === code) return error;
  const status = httpStatus(error);
  return new ErrorClass(redact(error?.message ?? error), code, {
    ...status === undefined ? {} : { status },
    ...error?.providerCode === undefined ? {} : { providerCode: error.providerCode },
    ...error?.responseId === undefined ? {} : { responseId: error.responseId },
    ...error?.requestId === undefined ? {} : { requestId: error.requestId },
    cause: error,
  });
}

export async function* streamWithRetry({
  options,
  body,
  authorizedToken,
  postOnce,
  toChunks,
  ErrorClass,
  abortMessage,
  sleepFn = sleep,
  replayKind,
  mapEvent,
}) {
  let token = await authorizedToken(false);
  let refreshed = false;
  let transportTries = 0;
  for (;;) {
    try {
      const events = await postOnce(options, token, body);
      if (events && typeof events[Symbol.asyncIterator] === "function") {
        const translator = createResponsesTranslator({ replayKind, mapEvent });
        let emitted = false;
        for await (const event of events) {
          const mapped = mapEvent ? mapEvent(event) : event;
          const failure = emitted ? undefined : responseEventError(mapped, ErrorClass);
          if (failure) throw failure;
          const chunks = translator.push(event);
          if (chunks.length > 0) emitted = true;
          for (const chunk of chunks) yield chunk;
        }
        for (const chunk of translator.finish()) yield chunk;
        return;
      }
      for (const chunk of toChunks(events)) yield chunk;
      return;
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ErrorClass(abortMessage, "ABORTED", { cause: error });
      }
      const kind = classifyResponsesFailure(error);
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
      if (kind === "reject") throw asResponsesError(error, "INVALID_REQUEST", ErrorClass);
      if (kind === "auth") throw asResponsesError(error, "INVALID_CREDENTIAL", ErrorClass);
      throw asResponsesError(error, "PROVIDER", ErrorClass);
    }
  }
}

export function effortList(entries) {
  return entries.map((entry) => {
    if (typeof entry === "string") return { id: entry, name: entry };
    const [id, name] = entry;
    return { id, name: name ?? id };
  });
}
