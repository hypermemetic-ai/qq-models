// /login and /logout grammar. Named connectors only; no TUI picker.

import { CONNECTORS, connectorIds, getConnector } from "./connectors.mjs";

export function parseLoginInput(rawInput) {
  const tokens = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "sheet" };
  if (tokens.length > 1) return { action: "error", text: `usage: /login [${connectorIds().join("|")}]` };
  const connector = getConnector(tokens[0]);
  if (!connector) return { action: "error", text: `unknown connector: ${tokens[0]}` };
  return { action: "login", connector: connector.id };
}

export function parseLogoutInput(rawInput) {
  const tokens = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "sheet" };
  if (tokens.length > 1) return { action: "error", text: `usage: /logout [${connectorIds().join("|")}]` };
  const connector = getConnector(tokens[0]);
  if (!connector) return { action: "error", text: `unknown connector: ${tokens[0]}` };
  return { action: "logout", connector: connector.id };
}

export function formatDeviceNotice({ label, verificationUri, userCode }) {
  return `Approve ${label} at ${verificationUri}\nCode: ${userCode}`;
}

export function loginSheetChoices() {
  return connectorIds().map((id) => ({
    id,
    label: CONNECTORS[id].label,
    hostOwned: CONNECTORS[id].kind === "host-key",
  }));
}

export function logoutSheetChoices() {
  return connectorIds().map((id) => ({
    id,
    label: CONNECTORS[id].label,
    hostOwned: !CONNECTORS[id].logout,
  }));
}
