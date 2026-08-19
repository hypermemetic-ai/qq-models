// Device-code login and refresh for grok and codex. Stolen shape, own files.

import { CODEX, GROK } from "./connectors.mjs";

export const GROK_OAUTH = Object.freeze({
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  deviceUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  grantType: "urn:ietf:params:oauth:grant-type:device_code",
  defaultIntervalSeconds: 5,
  minIntervalSeconds: 1,
  slowDownSeconds: 5,
  maxDurationMs: 15 * 60 * 1000,
  requestTimeoutMs: 15_000,
  maxResponseBytes: 64 * 1024,
  verificationOrigins: Object.freeze(["https://auth.x.ai", "https://accounts.x.ai"]),
});

export const CODEX_OAUTH = Object.freeze({
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  deviceUserCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  verificationUri: "https://auth.openai.com/codex/device",
  redirectUri: "https://auth.openai.com/deviceauth/callback",
  tokenUrl: "https://auth.openai.com/oauth/token",
  timeoutSeconds: 15 * 60,
  requestTimeoutMs: 15_000,
});

export const PACKAGE_IDENTITY = Object.freeze({
  product: "@hypermemetic-ai/qq-models",
  version: "0.0.0",
  // cli-chat-proxy.grok.com 426s versions below 0.1.202. This is the proxy
  // floor, not the npm version. User-Agent stays qq-models/0.0.0.
  grokClientVersion: "1.0.3",
  url: "https://github.com/hypermemetic-ai/qq",
});

export function userAgent() {
  return `${PACKAGE_IDENTITY.product}/${PACKAGE_IDENTITY.version} (+${PACKAGE_IDENTITY.url})`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value, maximum) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > maximum) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function positiveInteger(value, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : undefined;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Login cancelled"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function readBoundedJson(response, label, maxBytes) {
  const text = await response.text();
  if (text.length > maxBytes) throw new Error(`${label} was too large`);
  try {
    const value = JSON.parse(text);
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function validateGrokVerificationUri(value) {
  const uri = boundedString(value, 2048);
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "https:"
      || !GROK_OAUTH.verificationOrigins.includes(parsed.origin)
      || parsed.username
      || parsed.password
      || parsed.hash
    ) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function decodeJwt(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function grokHeaders(surface = "qq") {
  return {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": userAgent(),
    "X-Grok-Client-Surface": surface,
  };
}

export async function startGrokDevice({
  fetchImpl = fetch,
  signal,
  requestTimeoutMs = GROK_OAUTH.requestTimeoutMs,
} = {}) {
  const response = await fetchImpl(GROK_OAUTH.deviceUrl, {
    method: "POST",
    headers: grokHeaders(),
    body: new URLSearchParams({
      client_id: GROK_OAUTH.clientId,
      scope: GROK_OAUTH.scope,
      referrer: PACKAGE_IDENTITY.product,
    }).toString(),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Grok device authorization request failed with status ${response.status}`);
  }
  const data = await readBoundedJson(response, "Grok device authorization response", GROK_OAUTH.maxResponseBytes);
  const deviceCode = boundedString(data.device_code, 4096);
  const userCode = boundedString(data.user_code, 128);
  const verificationUri = validateGrokVerificationUri(data.verification_uri);
  const expiresInSeconds = positiveInteger(data.expires_in, 24 * 60 * 60);
  const intervalSeconds = data.interval === undefined
    ? GROK_OAUTH.defaultIntervalSeconds
    : positiveInteger(data.interval, 24 * 60 * 60);
  if (!deviceCode || !userCode || !/^[A-Za-z0-9-]+$/.test(userCode) || !verificationUri || !expiresInSeconds || !intervalSeconds) {
    throw new Error("Grok device authorization response had an invalid schema");
  }
  return {
    connector: GROK,
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: Math.max(GROK_OAUTH.minIntervalSeconds, intervalSeconds),
    expiresInSeconds: Math.min(expiresInSeconds, GROK_OAUTH.maxDurationMs / 1000),
    requestTimeoutMs,
  };
}

export async function pollGrokDevice(device, {
  fetchImpl = fetch,
  signal,
  now = Date.now,
  sleep = abortableSleep,
} = {}) {
  const startedAt = now();
  const timeoutMs = Math.min(device.expiresInSeconds * 1000, GROK_OAUTH.maxDurationMs);
  let intervalMs = Math.max(GROK_OAUTH.minIntervalSeconds * 1000, device.intervalSeconds * 1000);
  while (now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await sleep(intervalMs, signal);
    const response = await fetchImpl(GROK_OAUTH.tokenUrl, {
      method: "POST",
      headers: grokHeaders(),
      body: new URLSearchParams({
        grant_type: GROK_OAUTH.grantType,
        device_code: device.deviceCode,
        client_id: GROK_OAUTH.clientId,
      }).toString(),
      redirect: "error",
      signal,
    });
    if (response.ok) {
      const data = await readBoundedJson(response, "Grok device token response", GROK_OAUTH.maxResponseBytes);
      const access = boundedString(data.access_token, GROK_OAUTH.maxResponseBytes);
      const refresh = boundedString(data.refresh_token, GROK_OAUTH.maxResponseBytes);
      if (!access || !refresh) throw new Error("Grok device token response did not include tokens");
      const expiresIn = data.expires_in === undefined ? 21_600 : positiveInteger(data.expires_in, 24 * 60 * 60);
      if (!expiresIn) throw new Error("Grok device token response had an invalid schema");
      return {
        access,
        refresh,
        expires: now() + expiresIn * 1000,
        tokenEndpoint: GROK_OAUTH.tokenUrl,
      };
    }
    let data = {};
    try {
      data = await readBoundedJson(response, "Grok device token response", GROK_OAUTH.maxResponseBytes);
    } catch {
      throw new Error(`Grok device token request failed with status ${response.status}`);
    }
    const error = boundedString(data.error, 128);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs += GROK_OAUTH.slowDownSeconds * 1000;
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new Error("Grok device authorization was denied");
    }
    if (error === "expired_token") throw new Error("Grok device authorization expired");
    throw new Error(`Grok device authorization failed (${error || response.status})`);
  }
  throw new Error("Grok device authorization expired");
}

export async function refreshGrokToken(auth, {
  fetchImpl = fetch,
  signal,
  now = Date.now,
} = {}) {
  const response = await fetchImpl(GROK_OAUTH.tokenUrl, {
    method: "POST",
    headers: grokHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: GROK_OAUTH.clientId,
    }).toString(),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Grok token refresh failed with status ${response.status}`);
  }
  const data = await readBoundedJson(response, "Grok token refresh", GROK_OAUTH.maxResponseBytes);
  const access = boundedString(data.access_token, GROK_OAUTH.maxResponseBytes);
  const refresh = boundedString(data.refresh_token, GROK_OAUTH.maxResponseBytes) ?? auth.refresh;
  if (!access) throw new Error("Grok token refresh did not include an access token");
  const expiresIn = data.expires_in === undefined ? 21_600 : positiveInteger(data.expires_in, 24 * 60 * 60);
  if (!expiresIn) throw new Error("Grok token refresh had an invalid schema");
  return {
    access,
    refresh,
    expires: now() + expiresIn * 1000,
    tokenEndpoint: GROK_OAUTH.tokenUrl,
  };
}

export async function startCodexDevice({
  fetchImpl = fetch,
  signal,
} = {}) {
  const response = await fetchImpl(CODEX_OAUTH.deviceUserCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
    body: JSON.stringify({ client_id: CODEX_OAUTH.clientId }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Codex device authorization request failed with status ${response.status}`);
  }
  const data = await readBoundedJson(response, "Codex device authorization response", 64 * 1024);
  const intervalSeconds = typeof data.interval === "string" ? Number(data.interval.trim()) : data.interval;
  if (!data.device_auth_id || !data.user_code || !Number.isFinite(intervalSeconds) || intervalSeconds < 0) {
    throw new Error("Codex device authorization response had an invalid schema");
  }
  return {
    connector: CODEX,
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUri: CODEX_OAUTH.verificationUri,
    intervalSeconds,
    expiresInSeconds: CODEX_OAUTH.timeoutSeconds,
  };
}

export async function pollCodexDevice(device, {
  fetchImpl = fetch,
  signal,
  now = Date.now,
  sleep = abortableSleep,
} = {}) {
  const startedAt = now();
  const timeoutMs = device.expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, device.intervalSeconds * 1000);
  while (now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await sleep(intervalMs, signal);
    const response = await fetchImpl(CODEX_OAUTH.deviceTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent() },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
      signal,
    });
    if (response.ok) {
      const data = await readBoundedJson(response, "Codex device token response", 64 * 1024);
      if (!data.authorization_code || !data.code_verifier) {
        throw new Error("Codex device token response had an invalid schema");
      }
      return exchangeCodexAuthorization(data.authorization_code, data.code_verifier, {
        fetchImpl,
        signal,
        now,
      });
    }
    if (response.status === 403 || response.status === 404) continue;
    let errorCode;
    try {
      const json = await readBoundedJson(response, "Codex device token response", 64 * 1024);
      const error = json?.error;
      errorCode = typeof error === "object" ? error?.code : error;
    } catch {
      errorCode = undefined;
    }
    if (errorCode === "deviceauth_authorization_pending") continue;
    if (errorCode === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    throw new Error(`Codex device authorization failed with status ${response.status}`);
  }
  throw new Error("Codex device authorization expired");
}

async function exchangeCodexAuthorization(code, verifier, { fetchImpl, signal, now }) {
  const response = await fetchImpl(CODEX_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_OAUTH.redirectUri,
    }).toString(),
    signal,
  });
  return readCodexToken(response, now, "exchange");
}

export async function refreshCodexToken(auth, {
  fetchImpl = fetch,
  signal,
  now = Date.now,
} = {}) {
  const response = await fetchImpl(CODEX_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CODEX_OAUTH.clientId,
    }).toString(),
    signal,
  });
  return readCodexToken(response, now, "refresh");
}

async function readCodexToken(response, now, operation) {
  if (!response.ok) {
    throw new Error(`Codex token ${operation} failed with status ${response.status}`);
  }
  const data = await readBoundedJson(response, `Codex token ${operation}`, 64 * 1024);
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error(`Codex token ${operation} response missing fields`);
  }
  const accountId = decodeJwt(data.access_token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex token did not include an account id");
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: now() + data.expires_in * 1000,
    accountId,
  };
}

export function startDevice(connectorId, options) {
  if (connectorId === GROK) return startGrokDevice(options);
  if (connectorId === CODEX) return startCodexDevice(options);
  throw new Error(`unknown oauth connector: ${connectorId}`);
}

export function pollDevice(device, options) {
  if (device.connector === GROK) return pollGrokDevice(device, options);
  if (device.connector === CODEX) return pollCodexDevice(device, options);
  throw new Error(`unknown oauth connector: ${device.connector}`);
}

export function refreshToken(connectorId, auth, options) {
  if (connectorId === GROK) return refreshGrokToken(auth, options);
  if (connectorId === CODEX) return refreshCodexToken(auth, options);
  throw new Error(`unknown oauth connector: ${connectorId}`);
}

export const internals = Object.freeze({
  abortableSleep,
  decodeJwt,
});
