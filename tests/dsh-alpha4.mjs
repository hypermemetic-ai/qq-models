#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as QqModels from "../src/plugin.mjs";
import { CODEX_MODEL } from "../src/codex.mjs";
import { GROK_MODEL } from "../src/grok.mjs";

const require = createRequire(import.meta.url);
const dshLlmPkg = require("@deepseek-ai/dsh-llm/package.json");
const cordisPkg = require("@deepseek-ai/cordis/package.json");
assert.equal(dshLlmPkg.version, "0.1.2-alpha.4");
assert.equal(cordisPkg.version, "4.0.2");
assert.equal(dshLlmPkg.name, "@deepseek-ai/dsh-llm");

const GROK_ROUTE = "xai-auth";
const CODEX_ROUTE = "openai-codex";

function qqRoutes(providers) {
  return providers.filter((provider) => provider.id === GROK_ROUTE || provider.id === CODEX_ROUTE);
}

function assertRoutesOnce(providers, label) {
  const routes = qqRoutes(providers);
  assert.equal(routes.length, 2, `${label}: expected exactly two qq-models routes`);
  assert.deepEqual(routes.map((provider) => provider.id).sort(), [CODEX_ROUTE, GROK_ROUTE].sort());
  assert.equal(providers.filter((provider) => provider.id === GROK_ROUTE).length, 1, `${label}: grok once`);
  assert.equal(providers.filter((provider) => provider.id === CODEX_ROUTE).length, 1, `${label}: codex once`);
  const grok = providers.find((provider) => provider.id === GROK_ROUTE);
  const codex = providers.find((provider) => provider.id === CODEX_ROUTE);
  assert.equal(grok.name, "xAI Grok (qq)");
  assert.equal(codex.name, "OpenAI Codex (qq)");
}

const root = mkdtempSync(join(tmpdir(), "qq-models-dsh-"));
let fetchCalls = 0;
const config = {
  env: {
    HOME: root,
    DSH_HOME: join(root, "dsh-home"),
    QQ_DSH_HOME: join(root, "dsh-home"),
  },
  fetch: async () => {
    fetchCalls += 1;
    throw new Error("provider I/O must not run during DSH compatibility checks");
  },
};

const ctx = new Context();
try {
  await ctx.plugin(LlmRuntime);
  const first = ctx.plugin(QqModels, config);
  await first.await();

  assertRoutesOnce(ctx.llm.listProviders(), "first mount");

  const models = first.ctx.get("qq-models");
  assert.equal(models.grokAdapter.imageRequestPricing(GROK_ROUTE, GROK_MODEL.id), undefined);
  assert.equal(models.codexAdapter.imageRequestPricing(CODEX_ROUTE, CODEX_MODEL.id), undefined);
  assert.equal(ctx.llm.imageRequestPricing(GROK_ROUTE, GROK_MODEL.id), undefined);
  assert.equal(ctx.llm.imageRequestPricing(CODEX_ROUTE, CODEX_MODEL.id), undefined);

  const grokPrepared = await ctx.llm.prepareCall({ provider: GROK_ROUTE, model: GROK_MODEL.id });
  assert.equal(grokPrepared.config.provider, GROK_ROUTE);
  assert.equal(grokPrepared.config.model, GROK_MODEL.id);
  assert.equal(grokPrepared.config.maxTokens, GROK_MODEL.maxTokens);
  assert.equal(grokPrepared.config.reasoningEffort, GROK_MODEL.reasoning.defaultEffort);
  assert.equal(typeof grokPrepared.stream, "function");
  assert.equal(grokPrepared.adapterDefaults.maxTokens, true);
  assert.equal(grokPrepared.adapterDefaults.reasoningEffort, true);

  const grokAdapterCall = await models.grokAdapter.prepareCall(GROK_ROUTE, GROK_MODEL.id);
  assert.equal(grokAdapterCall.model.provider, GROK_ROUTE);
  assert.equal(grokAdapterCall.model.id, GROK_MODEL.id);
  assert.equal(grokAdapterCall.model.defaultMaxTokens, GROK_MODEL.maxTokens);
  assert.equal(grokAdapterCall.model.reasoning.defaultEffort, GROK_MODEL.reasoning.defaultEffort);
  assert.equal(typeof grokAdapterCall.stream, "function");

  const codexPrepared = await ctx.llm.prepareCall({ provider: CODEX_ROUTE, model: CODEX_MODEL.id });
  assert.equal(codexPrepared.config.provider, CODEX_ROUTE);
  assert.equal(codexPrepared.config.model, CODEX_MODEL.id);
  assert.equal(codexPrepared.config.maxTokens, CODEX_MODEL.maxTokens);
  assert.equal(codexPrepared.config.reasoningEffort, CODEX_MODEL.reasoning.defaultEffort);
  assert.equal(typeof codexPrepared.stream, "function");
  assert.equal(codexPrepared.adapterDefaults.maxTokens, true);
  assert.equal(codexPrepared.adapterDefaults.reasoningEffort, true);

  const codexAdapterCall = await models.codexAdapter.prepareCall(CODEX_ROUTE, CODEX_MODEL.id);
  assert.equal(codexAdapterCall.model.provider, CODEX_ROUTE);
  assert.equal(codexAdapterCall.model.id, CODEX_MODEL.id);
  assert.equal(codexAdapterCall.model.defaultMaxTokens, CODEX_MODEL.maxTokens);
  assert.equal(codexAdapterCall.model.reasoning.defaultEffort, CODEX_MODEL.reasoning.defaultEffort);
  assert.equal(typeof codexAdapterCall.stream, "function");

  assert.equal(fetchCalls, 0, "prepareCall must not perform provider I/O");
  assert.equal(models.grokAdapter.lastRequest, undefined);
  assert.equal(models.codexAdapter.lastRequest, undefined);

  await first.dispose();
  assert.deepEqual(qqRoutes(ctx.llm.listProviders()), [], "dispose must drop both routes");

  const remount = ctx.plugin(QqModels, config);
  await remount.await();
  assertRoutesOnce(ctx.llm.listProviders(), "remount");
  assert.equal(ctx.llm.imageRequestPricing(CODEX_ROUTE, CODEX_MODEL.id), undefined);
  const remounted = await ctx.llm.prepareCall({ provider: CODEX_ROUTE, model: CODEX_MODEL.id });
  assert.equal(remounted.config.model, CODEX_MODEL.id);
  assert.equal(remounted.config.maxTokens, CODEX_MODEL.maxTokens);
  assert.equal(remounted.config.reasoningEffort, CODEX_MODEL.reasoning.defaultEffort);
  assert.equal(fetchCalls, 0, "remount prepareCall must not fetch");

  await remount.dispose();
  assert.deepEqual(qqRoutes(ctx.llm.listProviders()), [], "second dispose must not leave a stale route");
  await ctx.fiber.dispose();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("dsh-alpha.4 stock-web adapter compatibility: ok");
