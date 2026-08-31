#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  CODEX_MODEL,
  CODEX_PROVIDER,
  RECOVERY,
  createGrokAutoContinue,
  isCodex,
  isRetryTarget,
  isRetryableGrokError,
} from "../src/grok-auto-continue.mjs";

const codexAgent = {
  session: {
    events: [{
      type: "request/header",
      data: { header: { config: { provider: CODEX_PROVIDER, model: CODEX_MODEL } } },
    }],
  },
};
assert.equal(isCodex(codexAgent), true);
assert.equal(isRetryTarget(codexAgent), true);
const providerFailure = {
  kind: "error",
  error: { message: "the provider reported a failed response", code: "PROVIDER" },
};
assert.equal(isRetryableGrokError(providerFailure), true);
assert.equal(isRetryableGrokError({
  kind: "error",
  error: {
    message: "Responses failed (provider_code=invalid_request_error)",
    code: "PROVIDER",
    providerCode: "invalid_request_error",
  },
}), false);

const followups = [];
const notices = [];
const controller = createGrokAutoContinue({
  isGrok: () => true,
  delay: async () => {},
  followup(message) { followups.push(message); },
  notify(message) { notices.push(message); },
  random: () => 0.5,
});
await controller.onTurnEnd({ data: { reason: providerFailure } }, codexAgent);
assert.equal(followups.length, 1);
assert.equal(followups[0].content[0].text, RECOVERY);
assert.match(notices[0], /responses-auto-continue/);

console.log("responses auto-continue: ok");
