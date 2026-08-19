// Named connectors this plugin can attach. A dict, not two hard slots.

export const GROK = "grok";
export const CODEX = "codex";
export const QWEN = "qwen";

export const CONNECTORS = Object.freeze({
  grok: Object.freeze({
    id: GROK,
    route: "xai-auth",
    kind: "oauth",
    label: "Grok",
    firstModel: "grok-4.6",
    logout: true,
  }),
  codex: Object.freeze({
    id: CODEX,
    route: "openai-codex",
    kind: "oauth",
    label: "Codex",
    firstModel: "gpt-5.6-sol",
    logout: true,
  }),
  qwen: Object.freeze({
    id: QWEN,
    route: "qwen-token-plan",
    kind: "host-key",
    label: "Qwen",
    firstModel: "deepseek-v4-pro-0813",
    logout: false,
  }),
});

export function connectorIds() {
  return Object.keys(CONNECTORS);
}

export function oauthConnectorIds() {
  return connectorIds().filter((id) => CONNECTORS[id].kind === "oauth");
}

export function getConnector(id) {
  return CONNECTORS[id] ?? null;
}

export function requireConnector(id) {
  const connector = getConnector(id);
  if (!connector) throw new Error(`unknown connector: ${id}`);
  return connector;
}

export function connectorByRoute(route) {
  return Object.values(CONNECTORS).find((connector) => connector.route === route) ?? null;
}
