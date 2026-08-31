#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  ResponsesLlmError,
  TRANSPORT_BACKOFF_MS,
  chunksFromEvents,
  providerFailureDetails,
  streamWithRetry,
} from "../src/responses.mjs";

const failedEvent = {
  type: "response.failed",
  request_id: "req_safe_123",
  response: {
    id: "resp_safe_456",
    status: "failed",
    error: { code: "server_error", message: "Temporary upstream failure" },
  },
};
const details = providerFailureDetails(failedEvent);
assert.match(details.message, /provider_code=server_error/);
assert.match(details.message, /response_id=resp_safe_456/);
assert.match(details.message, /request_id=req_safe_123/);
assert.match(details.message, /Temporary upstream failure/);
const translated = chunksFromEvents([failedEvent]);
assert.equal(translated.at(-1).reason.kind, "error");
assert.match(translated.at(-1).reason.failure.message, /provider_code=server_error/);

let attempts = 0;
const delays = [];
const recovered = [];
for await (const chunk of streamWithRetry({
  options: {},
  body: {},
  authorizedToken: async () => ({ access: "token" }),
  postOnce: async () => {
    attempts++;
    return (async function* () {
      if (attempts === 1) yield failedEvent;
      else yield { text: "recovered" };
    })();
  },
  toChunks: chunksFromEvents,
  ErrorClass: ResponsesLlmError,
  abortMessage: "aborted",
  sleepFn: async (ms) => { delays.push(ms); },
})) recovered.push(chunk);
assert.equal(attempts, 2, "a terminal provider SSE event retries before any model output");
assert.deepEqual(delays, [TRANSPORT_BACKOFF_MS[0]]);
assert.equal(recovered.at(-1).reason.kind, "stop");
assert.match(recovered.find((chunk) => chunk.type === "text-delta").text, /recovered/);

attempts = 0;
const terminalDelays = [];
await assert.rejects(async () => {
  for await (const _chunk of streamWithRetry({
    options: {},
    body: {},
    authorizedToken: async () => ({ access: "token" }),
    postOnce: async () => {
      attempts++;
      return (async function* () { yield failedEvent; })();
    },
    toChunks: chunksFromEvents,
    ErrorClass: ResponsesLlmError,
    abortMessage: "aborted",
    sleepFn: async (ms) => { terminalDelays.push(ms); },
  })) { /* consume */ }
}, (error) => {
  assert.equal(error.code, "PROVIDER");
  assert.equal(error.providerCode, "server_error");
  assert.equal(error.responseId, "resp_safe_456");
  assert.equal(error.requestId, "req_safe_123");
  assert.match(error.message, /Temporary upstream failure/);
  return true;
});
assert.equal(attempts, 3);
assert.deepEqual(terminalDelays, TRANSPORT_BACKOFF_MS);


const invalidEvent = {
  type: "response.failed",
  response: { error: { code: "invalid_request_error", message: "Unsupported request shape" } },
};
attempts = 0;
await assert.rejects(async () => {
  for await (const _chunk of streamWithRetry({
    options: {},
    body: {},
    authorizedToken: async () => ({ access: "token" }),
    postOnce: async () => {
      attempts++;
      return (async function* () { yield invalidEvent; })();
    },
    toChunks: chunksFromEvents,
    ErrorClass: ResponsesLlmError,
    abortMessage: "aborted",
    sleepFn: async () => { throw new Error("fatal provider rejection must not sleep"); },
  })) { /* consume */ }
}, (error) => {
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.providerCode, "invalid_request_error");
  return true;
});
assert.equal(attempts, 1);

console.log("responses recovery: ok");
