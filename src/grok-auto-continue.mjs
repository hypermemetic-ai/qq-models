// Grok 4.6 only. After a turn dies with a retryable xAI Responses failure,
// wait, then start a new turn with the same user followup the operator types.
// Repeat attempts in a 90s window replace the previous recovery on the model
// surface instead of stacking Continue. After five tries, stop. No model
// fallback yet. Delete the plugin attach to retire.

import { randomUUID } from "node:crypto";

export const TARGET_MODEL = "grok-4.6";
export const TARGET_PROVIDER = "xai-auth";
export const RETRY_LIMIT = 5;
export const RECOVERY = "Continue.";
export const WINDOW_MS = 90_000;
export const BACKOFF_MS = Object.freeze([2_000, 4_000, 8_000, 16_000, 32_000]);
export const JITTER = 0.1;
export const RETRYABLE = /responses failed/i;
export const FATAL_STATUS = new Set([400, 401, 403, 404, 422]);
export const FATAL_CODES = new Set([
  "INVALID_REQUEST",
  "INVALID_CREDENTIAL",
  "AUTH",
  "ABORTED",
  "MISSING_CREDENTIAL",
]);
export const PLUGIN = "qq-models";

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

export function defaultDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function backoffMs(attempt, { random = Math.random, delays = BACKOFF_MS, jitter = JITTER } = {}) {
  const base = delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
  if (!jitter) return base;
  const spread = base * jitter;
  return Math.max(0, Math.round(base - spread + random() * 2 * spread));
}

export function isGrok46(value) {
  if (!value) return false;
  if (typeof value === "string") return value === TARGET_MODEL;
  const model = value.model?.id
    ?? (typeof value.model === "string" ? value.model : undefined)
    ?? value.options?.model;
  if (model === TARGET_MODEL) return true;
  const events = value.session?.events ?? value.events;
  if (!Array.isArray(events)) return false;
  const context = events.findLast((event) => event?.type === "request/context");
  if (context?.data?.model === TARGET_MODEL) return true;
  const header = events.findLast((event) => event?.type === "request/header");
  return header?.data?.header?.config?.model === TARGET_MODEL;
}

export function failureOf(event) {
  return event?.data?.reason ?? event?.reason ?? event?.message ?? event;
}

export function failureText(value) {
  if (!value) return "";
  return String(value.errorMessage ?? value.error?.message ?? value.message ?? "");
}

export function errorStatus(value) {
  if (Number.isInteger(value?.error?.status)) return value.error.status;
  if (Number.isInteger(value?.status)) return value.status;
  const text = failureText(value);
  const labeled = text.match(/\bstatus\s+(\d{3})\b/i);
  if (labeled) return Number(labeled[1]);
  const code = text.match(/\b(40\d|42\d|50\d)\b/);
  return code ? Number(code[1]) : undefined;
}

export function isRetryableGrokError(value) {
  if (!value) return false;
  if (value.kind === "aborted" || value.kind === "interrupted") return false;
  if (value.role === "assistant" && value.stopReason === "aborted") return false;
  if (value.role === "assistant" && value.stopReason && value.stopReason !== "error") return false;
  if (value.kind && value.kind !== "error") return false;
  const text = failureText(value);
  if (!RETRYABLE.test(text)) return false;
  const code = value.error?.code ?? value.code;
  if (code && FATAL_CODES.has(code)) return false;
  const status = errorStatus(value);
  return status === undefined || !FATAL_STATUS.has(status);
}

export function recoveryMessage(kind = "user") {
  const source = kind === "plugin"
    ? { kind: "plugin", plugin: PLUGIN, form: "notice", summary: RECOVERY }
    : { kind: "user" };
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: RECOVERY }],
    source,
  };
}

export function recoveryRange(session, startSeq) {
  if (!Number.isInteger(startSeq)) return null;
  const events = session?.events ?? [];
  const nodes = Array.isArray(session?.surface?.nodes) && session.surface.nodes.length > 0
    ? session.surface.nodes
    : events.filter((event) =>
      event?.surfaceOp === "append"
      || event?.surfaceOp?.op === "replace"
      || event?.type === "user/message"
      || event?.type === "assistant/message"
      || event?.type === "tool/result"
    ).map((event) => event.seq);
  const inRange = nodes.filter((seq) => Number.isInteger(seq) && seq >= startSeq);
  if (inRange.length === 0) return null;
  return { start: inRange[0], end: inRange.at(-1), seqs: inRange };
}

export function createGrokAutoContinue(deps = {}) {
  const limit = Number.isInteger(deps.limit) && deps.limit > 0 ? deps.limit : RETRY_LIMIT;
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? defaultDelay;
  const random = deps.random ?? Math.random;
  const jitter = deps.jitter ?? JITTER;
  const followup = deps.followup ?? (() => {});
  const replace = deps.replace;
  const notify = deps.notify ?? (() => {});
  const isGrok = deps.isGrok ?? (() => true);
  const rangeFor = deps.rangeFor ?? (() => null);

  let attempts = 0;
  let pending = false;
  let pendingReplace = false;
  let lastAt = 0;
  let lastCtx;
  let anchorSeq;
  const sentIds = new Set();
  let waitAbort;

  const cancelWait = () => {
    waitAbort?.abort();
    waitAbort = undefined;
    pending = false;
  };

  const reset = () => {
    cancelWait();
    attempts = 0;
    pendingReplace = false;
    lastAt = 0;
    anchorSeq = undefined;
    sentIds.clear();
  };

  const applyReplace = () => {
    if (!pendingReplace || typeof replace !== "function") return;
    pendingReplace = false;
    const range = rangeFor(anchorSeq);
    if (!range) return;
    replace(range, recoveryMessage("plugin"));
  };

  const recover = () => {
    waitAbort = undefined;
    if (attempts >= limit) {
      pending = false;
      notify(`qq grok-auto-continue: ${attempts} Responses failed retries; stopped.`);
      return;
    }
    const message = recoveryMessage(attempts === 0 ? "user" : "plugin");
    sentIds.add(message.id);
    attempts += 1;
    lastAt = now();
    pending = true;
    pendingReplace = attempts > 1;
    followup(message);
    notify(`qq grok-auto-continue: Responses failed; continuing (${attempts}/${limit}).`);
  };

  const startWait = async () => {
    if (pending) return;
    if (!isGrok(lastCtx)) {
      reset();
      return;
    }
    if (lastAt > 0 && now() - lastAt > WINDOW_MS) {
      attempts = 0;
      pendingReplace = false;
      anchorSeq = undefined;
      sentIds.clear();
    }
    if (attempts >= limit) {
      notify(`qq grok-auto-continue: ${attempts} Responses failed retries; stopped.`);
      return;
    }
    pending = true;
    waitAbort = new AbortController();
    const signal = waitAbort.signal;
    try {
      await delay(backoffMs(attempts, { random, jitter }), signal);
    } catch {
      return;
    }
    if (signal.aborted) return;
    recover();
  };

  return {
    get attempts() { return attempts; },
    get pending() { return pending; },
    get pendingReplace() { return pendingReplace; },
    get anchorSeq() { return anchorSeq; },
    reset,
    dispose: reset,
    applyReplace,
    onTurnStart() {
      pending = false;
    },
    onUserMessage(event) {
      const data = event?.data ?? event;
      const id = data?.id;
      const seq = event?.seq;
      if (id && sentIds.has(id)) {
        if (anchorSeq === undefined && Number.isInteger(seq)) anchorSeq = seq;
        return;
      }
      if (data?.source?.kind === "user") reset();
    },
    onTurnEnd(event, ctx) {
      if (ctx) lastCtx = ctx;
      if (lastCtx?.signal?.aborted) {
        reset();
        return;
      }
      if (!isGrok(lastCtx)) {
        reset();
        return;
      }
      const failure = failureOf(event);
      if (failure?.kind === "aborted" || failure?.kind === "interrupted"
        || (failure?.role === "assistant" && failure.stopReason === "aborted")) {
        reset();
        return;
      }
      if (!isRetryableGrokError(failure)) {
        if (failure?.role === "assistant" && failure.stopReason !== "error") reset();
        if (failure?.kind && failure.kind !== "error") reset();
        return;
      }
      return startWait();
    },
  };
}

export function attachGrokAutoContinue(agent, deps = {}) {
  const session = agent?.session;
  const controller = createGrokAutoContinue({
    ...deps,
    isGrok: deps.isGrok ?? ((ctx) => isGrok46(ctx ?? agent)),
    followup: deps.followup ?? ((message) => agent?.followup?.(message)),
    replace: deps.replace ?? ((range, message) => {
      if (!session || typeof session.append !== "function") return;
      session.append("user/message", message, {
        surfaceOp: { op: "replace", start: range.start, end: range.end },
        sourceEventSeqs: range.seqs,
      });
    }),
    rangeFor: deps.rangeFor ?? ((startSeq) => recoveryRange(session, startSeq)),
    notify: deps.notify ?? ((text) => {
      const logger = agent?.ctx?.logger ?? deps.logger;
      logger?.warn?.(text);
    }),
  });

  const onEvent = (sessionOrEvent, maybeEvent) => {
    const event = maybeEvent ?? sessionOrEvent;
    if (!event || typeof event !== "object") return;
    if (event.type === "user/message") controller.onUserMessage(event);
    else if (event.type === "turn/start") controller.onTurnStart(event);
    else if (event.type === "turn/end") void controller.onTurnEnd(event);
  };

  const onRequest = async (_payload, next) => {
    try {
      controller.applyReplace();
    } catch (error) {
      const logger = agent?.ctx?.logger ?? deps.logger;
      logger?.warn?.(
        `qq grok-auto-continue: history replace refused (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    return typeof next === "function" ? next() : undefined;
  };

  const disposeEvent = agent?.ctx?.on?.("session/event", onEvent);
  const disposeRequest = agent?.ctx?.on?.("agent/request", onRequest);
  return () => {
    controller.dispose();
    disposeEvent?.();
    disposeRequest?.();
  };
}

export function attachAgents(ctx, deps = {}) {
  const agents = ctx?.get?.("agents", false) ?? ctx?.agents;
  const attached = new WeakSet();
  const disposers = new WeakMap();
  const attach = (agent) => {
    if (!agent || attached.has(agent)) return;
    attached.add(agent);
    disposers.set(agent, attachGrokAutoContinue(agent, deps));
  };
  if (typeof ctx?.on === "function") {
    ctx.on("agent/created", ({ agent }) => attach(agent));
    ctx.on("agent/disposed", ({ agent }) => {
      disposers.get(agent)?.();
      disposers.delete(agent);
      attached.delete(agent);
    });
  }
  if (typeof agents?.list === "function") {
    for (const agent of agents.list()) {
      try {
        attach(agent);
      } catch {
        // One live agent must not unload qq-models.
      }
    }
  }
}
