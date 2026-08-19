#!/usr/bin/env node
// Terminal bootstrap for the same store and device-code flows as /login.
// Named arguments only. Does not start the long-lived host.

import { createAuthStore } from "../src/store.mjs";
import { createLoginService } from "../src/login.mjs";
import { CONNECTORS, oauthConnectorIds } from "../src/connectors.mjs";
import { qwenStatusText } from "../src/qwen.mjs";

const usage = "usage: qq-login grok | codex | status | logout grok | logout codex";

async function main(argv) {
  const store = createAuthStore();
  const login = createLoginService({ store });
  const [head, ...rest] = argv;
  if (!head || head === "-h" || head === "--help") {
    console.log(usage);
    return 0;
  }
  if (head === "status") {
    for (const row of login.status()) {
      console.log(`${row.id}\t${row.route}\t${row.ready ? "ready" : "logged-out"}`);
    }
    console.log(`qwen\t${CONNECTORS.qwen.route}\t${qwenStatusText()}`);
    return 0;
  }
  if (head === "logout") {
    const connector = rest[0];
    if (!oauthConnectorIds().includes(connector) && connector !== "qwen") {
      console.error(usage);
      return 2;
    }
    const result = await login.logoutNamed(connector);
    console.log(result.text);
    return result.kind === "error" ? 1 : 0;
  }
  if (rest.length > 0 || !["grok", "codex", "qwen"].includes(head)) {
    console.error(usage);
    return 2;
  }
  const result = await login.handleLogin({ rawInput: head });
  console.log(result.text);
  if (result.kind === "error") return 1;
  const poll = login.polls.get(head);
  if (poll?.work) await poll.work;
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
