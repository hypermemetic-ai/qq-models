// Qwen stays on the host recipe. This plugin only reports whether the leftover
// key is present. It never writes a second Qwen key file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveDshHome } from "./home.mjs";

export const QWEN_KEY_NAME = "QWEN_TOKEN_PLAN_API_KEY";

function hasYamlKey(file) {
  if (!existsSync(file)) return false;
  try {
    return /^\s*QWEN_TOKEN_PLAN_API_KEY\s*:\s*\S/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

function hasEnvKey(file) {
  if (!existsSync(file)) return false;
  try {
    return /^\s*(export\s+)?QWEN_TOKEN_PLAN_API_KEY\s*=/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

export function qwenReady(env = process.env, { repoRoot } = {}) {
  if (String(env.QWEN_TOKEN_PLAN_API_KEY ?? "").trim()) return true;
  const home = resolveDshHome(env);
  if (hasYamlKey(join(home, ".credentials.yaml"))) return true;
  if (hasEnvKey(join(home, ".env"))) return true;
  if (repoRoot && hasEnvKey(join(repoRoot, ".env"))) return true;
  return false;
}

export function qwenStatusText(env = process.env, options = {}) {
  const home = resolveDshHome(env);
  if (qwenReady(env, options)) return "qwen is ready (host key).";
  return `qwen needs ${QWEN_KEY_NAME} in ${home}/.credentials.yaml. Do not paste keys into the composer.`;
}

export function qwenLogoutText(env = process.env) {
  const home = resolveDshHome(env);
  return `qwen is host-owned. Remove ${QWEN_KEY_NAME} from ${home}/.credentials.yaml yourself if you mean it.`;
}
