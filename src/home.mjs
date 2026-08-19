// Resolve this host's DSH_HOME the same way bin/qq does.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const AUTH_SCHEMA = "qq.models-auth/v1";

function requireAbsolute(path, label) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new Error(`qq-models: ${label} must be an absolute path`);
  }
  return path;
}

function homeDir(env = process.env) {
  const home = env.HOME || homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error("qq-models: HOME must be an absolute path when DSH_HOME is unset");
  }
  return home;
}

/** Same resolution as bin/qq: QQ_DSH_HOME, then DSH_HOME, then $XDG_STATE_HOME/qq. */
export function resolveDshHome(env = process.env) {
  const qqHome = env.QQ_DSH_HOME?.trim();
  if (qqHome) return requireAbsolute(qqHome, "QQ_DSH_HOME");
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) return requireAbsolute(dshHome, "DSH_HOME");
  const stateRoot = env.XDG_STATE_HOME?.trim();
  if (stateRoot) return join(requireAbsolute(stateRoot, "XDG_STATE_HOME"), "qq");
  return join(homeDir(env), ".local/state/qq");
}

export function authFileName(connectorId) {
  return `.qq-${connectorId}-auth.json`;
}

export function authFilePath(connectorId, env = process.env, config = {}) {
  if (config.homeDir !== undefined) {
    return join(requireAbsolute(config.homeDir, "homeDir"), authFileName(connectorId));
  }
  return join(resolveDshHome(env), authFileName(connectorId));
}

export const internals = Object.freeze({
  requireAbsolute,
  homeDir,
});
