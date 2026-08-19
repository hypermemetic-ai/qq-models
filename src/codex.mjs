// openai-codex adapter. ChatGPT backend Responses with this plugin's store.

import { CODEX } from "./connectors.mjs";
import { refreshCodexToken, userAgent } from "./oauth.mjs";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_MODEL = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  contextWindow: 272_000,
  maxTokens: 128_000,
  input: Object.freeze(["text", "image"]),
};

function toInput(messages, system) {
  const input = [];
  if (system) input.push({ role: "system", content: [{ type: "input_text", text: system }] });
  for (const message of messages ?? []) {
    const text = Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("")
      : String(message.content ?? "");
    input.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text }],
    });
  }
  return input;
}

export function createCodexAdapter({
  store,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  async function token() {
    return store.accessToken(CODEX, (current) => refreshCodexToken(current, { fetchImpl, now }));
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
      });
    },
    async *stream(options) {
      const auth = await token();
      const headers = {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.access}`,
        "User-Agent": userAgent(),
        "chatgpt-account-id": auth.accountId,
      };
      this.lastRequest = { url: CODEX_URL, model: options.model, hasAuthorization: true };
      const response = await fetchImpl(CODEX_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: options.model,
          stream: true,
          input: toInput(options.messages, options.system),
        }),
        signal: options.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => response.statusText);
        const error = new Error(`Codex request failed (${response.status})${detail ? `: ${detail}` : ""}`);
        error.status = response.status;
        error.code = response.status === 401 ? "INVALID_CREDENTIAL" : "PROVIDER";
        throw error;
      }
      const body = await response.text();
      const text = body.replace(/^data:\s*/gm, "").replace(/\[DONE\]/g, "").trim();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      const output = parsed?.output_text ?? parsed?.text ?? (parsed ? "" : text);
      if (output) {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: output };
        yield { type: "block-end", index: 0, block: { type: "text", text: output } };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}
