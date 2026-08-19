// One file per OAuth connector. Mode 0600. Atomic write. Refresh locked so
// two qq processes cannot rotate the same refresh token.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { AUTH_SCHEMA, authFilePath } from "./home.mjs";

const MODE = 0o600;
const DIR_MODE = 0o700;
const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_TIMEOUT_MS = 2_000;
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const FORBIDDEN_PATHS = Object.freeze([
  ".pi/agent/auth.json",
  ".codex/auth.json",
  ".grok/auth.json",
  ".openai-codex-auth.json",
  ".dsh/plugins/subscriptions/auth.json",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEEXIST(error) {
  return error && typeof error === "object" && error.code === "EEXIST";
}

function atomicWrite(file, text, mode = MODE) {
  mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
  try { chmodSync(dirname(file), DIR_MODE); } catch { /* already 0700 */ }
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
    renameSync(temporary, file);
    try { chmodSync(file, mode); } catch { /* already 0600 */ }
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* gone */ }
    throw error;
  }
}

async function withFileLock(filename, operation) {
  mkdirSync(dirname(filename), { recursive: true, mode: DIR_MODE });
  try { chmodSync(dirname(filename), DIR_MODE); } catch { /* already 0700 */ }
  const lockPath = `${filename}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = LOCK_RETRY_INITIAL_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { mode: MODE, flag: "wx" });
      break;
    } catch (error) {
      if (!isEEXIST(error) || Date.now() >= deadline) {
        throw new Error(`qq-models: timed out locking ${filename}`);
      }
      await sleep(delay);
      delay = Math.min(LOCK_RETRY_MAX_MS, delay * 2);
    }
  }
  try {
    return await operation();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already released */ }
  }
}

function assertPluginFile(file) {
  const normalized = String(file).replaceAll("\\", "/");
  for (const forbidden of FORBIDDEN_PATHS) {
    if (normalized.endsWith(forbidden) || normalized.includes(`/${forbidden}`)) {
      throw new Error("qq-models: refusing a foreign auth file");
    }
  }
}

function parseAuth(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.schema !== AUTH_SCHEMA) return null;
  if (raw.type !== "oauth") return null;
  if (typeof raw.connector !== "string" || raw.connector.length === 0) return null;
  if (typeof raw.access !== "string" || raw.access.length === 0) return null;
  if (typeof raw.refresh !== "string" || raw.refresh.length === 0) return null;
  if (!Number.isFinite(raw.expires)) return null;
  return {
    schema: AUTH_SCHEMA,
    type: "oauth",
    connector: raw.connector,
    access: raw.access,
    refresh: raw.refresh,
    expires: raw.expires,
    ...(typeof raw.accountId === "string" && raw.accountId ? { accountId: raw.accountId } : {}),
    ...(typeof raw.tokenEndpoint === "string" && raw.tokenEndpoint ? { tokenEndpoint: raw.tokenEndpoint } : {}),
  };
}

export function createAuthStore({
  env = process.env,
  homeDir,
  now = Date.now,
  refreshSkewMs = REFRESH_SKEW_MS,
} = {}) {
  const config = homeDir === undefined ? {} : { homeDir };

  function pathFor(connectorId) {
    const file = authFilePath(connectorId, env, config);
    assertPluginFile(file);
    return file;
  }

  function read(connectorId) {
    const file = pathFor(connectorId);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const auth = parseAuth(parsed);
      if (!auth || auth.connector !== connectorId) return null;
      return auth;
    } catch {
      return null;
    }
  }

  function present(connectorId) {
    return read(connectorId) !== null;
  }

  async function write(connectorId, fields) {
    const file = pathFor(connectorId);
    const next = parseAuth({
      schema: AUTH_SCHEMA,
      type: "oauth",
      connector: connectorId,
      ...fields,
    });
    if (!next || next.connector !== connectorId) {
      throw new Error(`qq-models: refusing to write an incomplete ${connectorId} auth file`);
    }
    await withFileLock(file, async () => {
      atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    });
    return next;
  }

  async function remove(connectorId) {
    const file = pathFor(connectorId);
    await withFileLock(file, async () => {
      try { unlinkSync(file); } catch { /* already gone */ }
    });
  }

  function needsRefresh(auth, at = now()) {
    if (!auth) return false;
    return !Number.isFinite(auth.expires) || auth.expires - refreshSkewMs <= at;
  }

  async function rotate(connectorId, refresher) {
    const file = pathFor(connectorId);
    return withFileLock(file, async () => {
      const current = read(connectorId);
      if (!current) throw new Error(`qq-models: ${connectorId} is not logged in`);
      const rotated = await refresher(current);
      const next = parseAuth({
        schema: AUTH_SCHEMA,
        type: "oauth",
        connector: connectorId,
        ...rotated,
      });
      if (!next || next.connector !== connectorId) {
        throw new Error(`qq-models: ${connectorId} refresh returned an incomplete token`);
      }
      atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  async function accessToken(connectorId, refresher) {
    const current = read(connectorId);
    if (!current) throw new Error(`qq-models: ${connectorId} is not logged in`);
    if (!needsRefresh(current) || typeof refresher !== "function") return current;
    return rotate(connectorId, refresher);
  }

  return Object.freeze({
    pathFor,
    read,
    present,
    write,
    remove,
    needsRefresh,
    rotate,
    accessToken,
  });
}

export const internals = Object.freeze({
  MODE,
  DIR_MODE,
  REFRESH_SKEW_MS,
  FORBIDDEN_PATHS,
  atomicWrite,
  withFileLock,
  parseAuth,
});
