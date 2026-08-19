// Device-code login, logout, and sheets. HTTP returns at once; poll is background.

import {
  formatDeviceNotice,
  loginSheetChoices,
  logoutSheetChoices,
  parseLoginInput,
  parseLogoutInput,
} from "./command.mjs";
import { CONNECTORS, oauthConnectorIds, requireConnector } from "./connectors.mjs";
import { injectNotice } from "./notice.mjs";
import { pollDevice, refreshToken, startDevice } from "./oauth.mjs";
import { qwenLogoutText, qwenStatusText } from "./qwen.mjs";

function errorResult(text) {
  return { kind: "error", text };
}

function successResult(text) {
  return { kind: "success", text };
}

export function createLoginService({
  store,
  env = process.env,
  fetchImpl,
  now = Date.now,
  sleep,
  startDeviceFn = startDevice,
  pollDeviceFn = pollDevice,
  refreshTokenFn = refreshToken,
} = {}) {
  const polls = new Map();
  const sheets = new Map();
  const cancelled = new Set();

  function sheetFor(sessionId) {
    return sheets.get(sessionId) ?? null;
  }

  function clearSheet(sessionId) {
    sheets.delete(sessionId);
  }

  function abortPoll(connectorId) {
    const poll = polls.get(connectorId);
    if (!poll) return false;
    poll.controller.abort();
    return true;
  }

  function beginPoll(connectorId, device, agent) {
    abortPoll(connectorId);
    cancelled.delete(connectorId);
    const controller = new AbortController();
    const work = pollDeviceFn(device, {
      fetchImpl,
      now,
      sleep,
      signal: controller.signal,
    }).then(async (tokens) => {
      if (controller.signal.aborted || cancelled.has(connectorId)) return;
      await store.write(connectorId, tokens);
      if (controller.signal.aborted || cancelled.has(connectorId)) {
        await store.remove(connectorId);
        return;
      }
      const label = CONNECTORS[connectorId].label;
      if (agent) injectNotice(agent, `${label} logged in.`);
    }).catch((error) => {
      if (controller.signal.aborted || cancelled.has(connectorId)) return;
      const text = error instanceof Error ? error.message : String(error);
      if (agent) injectNotice(agent, `${CONNECTORS[connectorId].label} login failed: ${text}`);
    }).finally(() => {
      const current = polls.get(connectorId);
      if (current?.controller === controller) polls.delete(connectorId);
    });
    polls.set(connectorId, { controller, work });
    return work;
  }

  async function loginNamed(connectorId, agent) {
    const connector = requireConnector(connectorId);
    if (connector.kind === "host-key") return successResult(qwenStatusText(env));
    const device = await startDeviceFn(connectorId, { fetchImpl });
    beginPoll(connectorId, device, agent);
    return successResult(formatDeviceNotice({
      label: connector.label,
      verificationUri: device.verificationUri,
      userCode: device.userCode,
    }));
  }

  async function logoutNamed(connectorId) {
    const connector = requireConnector(connectorId);
    if (!connector.logout) return successResult(qwenLogoutText(env));
    abortPoll(connectorId);
    cancelled.add(connectorId);
    await store.remove(connectorId);
    return successResult(`${connector.label} logged out on this host.`);
  }

  async function handleLogin({ agent, rawInput }) {
    const sessionId = agent?.session?.id ?? agent?.id ?? "";
    const parsed = parseLoginInput(rawInput);
    if (parsed.action === "error") return errorResult(parsed.text);
    if (parsed.action === "sheet") {
      sheets.set(sessionId, { action: "login", connectors: loginSheetChoices() });
      return successResult("Pick a connector.");
    }
    clearSheet(sessionId);
    try {
      return await loginNamed(parsed.connector, agent);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLogout({ agent, rawInput }) {
    const sessionId = agent?.session?.id ?? agent?.id ?? "";
    const parsed = parseLogoutInput(rawInput);
    if (parsed.action === "error") return errorResult(parsed.text);
    if (parsed.action === "sheet") {
      sheets.set(sessionId, { action: "logout", connectors: logoutSheetChoices() });
      return successResult("Pick a connector to drop.");
    }
    clearSheet(sessionId);
    try {
      return await logoutNamed(parsed.connector);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  function choose(sessionId, connectorId, action = "login") {
    clearSheet(sessionId);
    return { command: `/${action} ${connectorId}` };
  }

  function status() {
    return oauthConnectorIds().map((id) => ({
      id,
      label: CONNECTORS[id].label,
      route: CONNECTORS[id].route,
      ready: store.present(id),
    }));
  }

  async function refresh(connectorId) {
    return store.rotate(connectorId, (current) => refreshTokenFn(connectorId, current, { fetchImpl, now }));
  }

  return Object.freeze({
    handleLogin,
    handleLogout,
    loginNamed,
    logoutNamed,
    sheetFor,
    clearSheet,
    choose,
    abortPoll,
    beginPoll,
    status,
    refresh,
    polls,
  });
}
