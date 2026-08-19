// qq-models: one repository, one plugin. Cordis entry point.
//
// Loading this plugin is how a DSH host connects language models. qq expects
// it and still runs if it is absent. The start script already binds qq-*
// siblings; this package is not named in bin/qq or host.patch.yml.

import { CONNECTORS } from "./connectors.mjs";
import { createGrokAdapter } from "./grok.mjs";
import { createCodexAdapter } from "./codex.mjs";
import { createAuthStore } from "./store.mjs";
import { createLoginService } from "./login.mjs";
import { qwenReady } from "./qwen.mjs";

export const name = "qq-models";
export const inject = [];
export const provide = "qq-models";

export function apply(ctx, config = {}) {
  const store = createAuthStore({
    env: config.env ?? process.env,
    homeDir: config.homeDir,
    now: config.now,
  });
  const login = createLoginService({
    store,
    env: config.env ?? process.env,
    fetchImpl: config.fetch,
    now: config.now,
    sleep: config.sleep,
    startDeviceFn: config.startDevice,
    pollDeviceFn: config.pollDevice,
    refreshTokenFn: config.refreshToken,
  });

  const grokAdapter = createGrokAdapter({
    store,
    fetchImpl: config.fetch,
    now: config.now,
    sleepFn: config.sleep,
  });
  const codexAdapter = createCodexAdapter({
    store,
    fetchImpl: config.fetch,
    now: config.now,
  });

  const registerWithEffect = (holder, fn, label) => {
    try {
      if (typeof holder.effect === "function") return holder.effect(fn, label);
      return fn();
    } catch (error) {
      holder.logger?.warn?.(`${label}: ${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  };

  const registerAdapters = (llmCtx) => {
    const llm = llmCtx.get?.("llm", false) ?? llmCtx.llm;
    if (!llm || typeof llm.registerAdapter !== "function") return;
    // Missing credentials fail the stream; the routes stay registered so a
    // later /login can talk without a restart. Duplicate host adapters are a
    // leftover, not a boot failure.
    for (const [provider, adapter] of [["xai-auth", grokAdapter], ["openai-codex", codexAdapter]]) {
      registerWithEffect(
        llmCtx,
        () => llm.registerAdapter([provider], adapter),
        `qq-models: ${provider}`,
      );
    }
  };
  if (typeof ctx.inject === "function") ctx.inject(["llm"], registerAdapters);
  else registerAdapters(ctx);

  const registerCommand = (commandCtx) => {
    const commands = commandCtx.get("commands", false);
    if (!commands || typeof commands.register !== "function") return;
    registerWithEffect(
      commandCtx,
      () => commands.register({
        name: "login",
        description: "Connect a named model connector, or pick one.",
        input: { hint: "grok | codex | qwen" },
        handler: (invocation) => login.handleLogin(invocation),
      }),
      "qq-models: /login",
    );
    registerWithEffect(
      commandCtx,
      () => commands.register({
        name: "logout",
        description: "Drop this host's file for a named connector.",
        input: { hint: "grok | codex | qwen" },
        handler: (invocation) => login.handleLogout(invocation),
      }),
      "qq-models: /logout",
    );
  };
  if (typeof ctx.inject === "function") ctx.inject(["commands"], registerCommand);
  else registerCommand(ctx);

  const service = Object.freeze({
    store,
    login,
    connectors: CONNECTORS,
    sheetFor: (sessionId) => login.sheetFor(sessionId),
    choose: (sessionId, connectorId, action) => login.choose(sessionId, connectorId, action),
    qwenReady: () => qwenReady(config.env ?? process.env, { repoRoot: config.repoRoot }),
    grokAdapter,
    codexAdapter,
  });
  ctx.provide("qq-models", service);
}

export const internals = Object.freeze({
  CONNECTORS,
});
