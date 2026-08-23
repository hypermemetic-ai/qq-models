// Read-only lookup of Pi's Codex OAuth so qq can talk without a second login.
// Never write this file. Refresh writes qq's own `.qq-codex-auth.json`.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFileSync } from "node:fs";

import { CODEX } from "./connectors.mjs";

export function piAuthPath(env = process.env) {
  const home = env.HOME || homedir();
  if (typeof home !== "string" || home.length === 0 || !isAbsolute(home)) return null;
  return join(home, ".pi", "agent", "auth.json");
}

export function readPiCodexAuth(env = process.env) {
  const path = piAuthPath(env);
  if (!path) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const entry = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed[CODEX] ?? parsed["openai-codex"] : null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (typeof entry.access !== "string" || entry.access.length === 0) return null;
  if (typeof entry.refresh !== "string" || entry.refresh.length === 0) return null;
  if (!Number.isFinite(entry.expires)) return null;
  return {
    access: entry.access,
    refresh: entry.refresh,
    expires: entry.expires,
    ...(typeof entry.accountId === "string" && entry.accountId ? { accountId: entry.accountId } : {}),
  };
}
