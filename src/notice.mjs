// Plugin-source notice after a background poll succeeds.

import { randomUUID } from "node:crypto";

export function pluginNotice(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq-models" },
  };
}

export function injectNotice(agent, text) {
  const session = agent?.session;
  if (session && typeof session.append === "function") {
    session.append("user/message", pluginNotice(text), { surfaceOp: "append" });
    return;
  }
  if (agent && typeof agent.followup === "function") {
    agent.followup(pluginNotice(text));
  }
}
