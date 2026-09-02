#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AUTH_SCHEMA, authFileName } from "../src/home.mjs";
import { readPiCodexAuth } from "../src/pi-auth.mjs";
import { createAuthStore, internals } from "../src/store.mjs";

const MODE_MASK = 0o777;
const realHome = process.env.HOME;
assert.equal(typeof realHome, "string");
assert.equal(realHome.startsWith("/"), true, "real HOME must be absolute");
const realPiPath = join(realHome, ".pi", "agent", "auth.json");
const realGuardPaths = [
  realPiPath,
  join(realHome, authFileName("codex")),
  join(realHome, authFileName("grok")),
  join(realHome, ".local", "state", "qq", authFileName("codex")),
  join(realHome, ".local", "state", "qq", authFileName("grok")),
];
for (const key of ["DSH_HOME", "QQ_DSH_HOME"]) {
  const value = process.env[key];
  if (typeof value === "string" && value.startsWith("/")) {
    realGuardPaths.push(
      join(value, authFileName("codex")),
      join(value, authFileName("grok")),
    );
  }
}
const realGuards = new Map(realGuardPaths.map((path) => [path, existsSync(path) ? {
  stat: statSync(path),
  bytes: readFileSync(path),
} : null]));

const roots = [];
function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `qq-models-${label}-`));
  roots.push(root);
  return root;
}

function modeOf(path) {
  return statSync(path).mode & MODE_MASK;
}

function writePiAuth(home, access) {
  const path = join(home, ".pi", "agent", "auth.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    codex: {
      access,
      refresh: "refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function assertRealStoresUntouched() {
  for (const [path, before] of realGuards) {
    if (before) {
      const current = statSync(path);
      assert.equal(current.mtimeMs, before.stat.mtimeMs, `${path} mtime must not change`);
      assert.deepEqual(readFileSync(path), before.bytes, `${path} bytes must not change`);
    } else {
      assert.equal(existsSync(path), false, `must not create ${path}`);
    }
  }
}

try {
  const isolatedHome = tempRoot("home");
  const dshHome = join(isolatedHome, "dsh-home");
  const foreignHome = tempRoot("foreign");
  const foreignPiPath = writePiAuth(foreignHome, "foreign-pi-access");
  const foreignPiBytes = readFileSync(foreignPiPath);

  const env = {
    HOME: isolatedHome,
    DSH_HOME: dshHome,
  };
  const store = createAuthStore({
    env,
    fallbacks: { codex: () => readPiCodexAuth(env) },
  });

  assert.equal(store.pathFor("grok"), join(dshHome, authFileName("grok")));
  assert.equal(store.pathFor("codex"), join(dshHome, ".qq-codex-auth.json"));
  assert.equal(store.present("grok"), false);
  assert.equal(store.present("codex"), false);
  assert.equal(store.read("codex"), null);
  assert.equal(readPiCodexAuth(env), null, "isolated HOME must not see a foreign Pi store");
  assert.equal(readPiCodexAuth({ HOME: foreignHome }).access, "foreign-pi-access");
  assert.equal(existsSync(join(isolatedHome, ".pi")), false);

  const written = await store.write("codex", {
    access: "isolated-access",
    refresh: "isolated-refresh",
    expires: 1_700_000_000_000,
  });
  assert.equal(written.schema, AUTH_SCHEMA);
  assert.equal(written.connector, "codex");
  assert.equal(written.access, "isolated-access");

  const authPath = store.pathFor("codex");
  assert.equal(existsSync(authPath), true);
  assert.equal(modeOf(dshHome), internals.DIR_MODE);
  assert.equal(modeOf(authPath), internals.MODE);
  assert.equal(existsSync(join(isolatedHome, ".pi")), false);
  assert.equal(existsSync(join(foreignHome, authFileName("codex"))), false);
  assert.deepEqual(readFileSync(foreignPiPath), foreignPiBytes);
  assert.equal(store.read("codex").access, "isolated-access");
  assert.equal(store.present("codex"), true);

  const grok = await store.write("grok", {
    access: "grok-access",
    refresh: "grok-refresh",
    expires: 1_700_000_000_001,
  });
  assert.equal(grok.connector, "grok");
  assert.equal(modeOf(store.pathFor("grok")), internals.MODE);
  assert.equal(dirname(store.pathFor("grok")), dshHome);

  for (const forbidden of internals.FORBIDDEN_PATHS) {
    const homeDir = join(tempRoot("forbidden"), forbidden);
    const forbiddenStore = createAuthStore({ env, homeDir });
    assert.throws(
      () => forbiddenStore.pathFor("codex"),
      /refusing a foreign auth file/,
      forbidden,
    );
  }

  const fallbackHome = tempRoot("pi-fallback");
  writePiAuth(fallbackHome, "isolated-pi-access");
  const fallbackEnv = { HOME: fallbackHome, DSH_HOME: join(fallbackHome, "dsh-home") };
  const fallbackStore = createAuthStore({
    env: fallbackEnv,
    fallbacks: { codex: () => readPiCodexAuth(fallbackEnv) },
  });
  assert.equal(fallbackStore.read("codex"), null, "Pi fallback is not the plugin auth file");
  assert.equal(fallbackStore.present("codex"), true, "Codex may read Pi only from isolated HOME");
  assert.equal(fallbackStore.present("grok"), false);
  const fromPi = readPiCodexAuth(fallbackEnv);
  assert.equal(fromPi.access, "isolated-pi-access");
  assert.equal(existsSync(fallbackStore.pathFor("codex")), false);

  assertRealStoresUntouched();
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  assertRealStoresUntouched();
}

console.log("auth-store isolation: ok");
