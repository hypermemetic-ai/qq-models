# `@hypermemetic-ai/qq-models`

Private ESM package providing named model connectors for the core DSH host. The package root resolves to [`src/plugin.mjs`](src/plugin.mjs); its declared package surface and DSH bundle metadata live in [`package.json`](package.json).

## Run and verify

The only declared package script is:

```sh
npm test
```

It syntax-checks [`src/plugin.mjs`](src/plugin.mjs), then runs [`tests/responses.mjs`](tests/responses.mjs) and [`tests/auto-continue.mjs`](tests/auto-continue.mjs). No install or start script, or Node.js version, is declared in the package metadata.

The package also maps the `qq-models-login` executable to [`bin/login.mjs`](bin/login.mjs).

## System map

- **Host integration:** [`src/plugin.mjs`](src/plugin.mjs) is both the main module and root export. The DSH bundle points at [`cordis.patch.yml`](cordis.patch.yml).
- **Connector boundary:** [`src/connectors.mjs`](src/connectors.mjs) is an exported subpath and has the repository's highest relative-module fan-in. Model-named implementations are in [`src/codex.mjs`](src/codex.mjs), [`src/grok.mjs`](src/grok.mjs), and [`src/qwen.mjs`](src/qwen.mjs); Qwen is also a declared subpath export.
- **Other public subpaths:** [`src/home.mjs`](src/home.mjs), [`src/store.mjs`](src/store.mjs), [`src/command.mjs`](src/command.mjs), and [`src/login.mjs`](src/login.mjs).
- **Focused behavior and validation:** response-related work is separated into [`src/responses.mjs`](src/responses.mjs), while Grok auto-continuation has [`src/grok-auto-continue.mjs`](src/grok-auto-continue.mjs).

Because `src/connectors.mjs` is widely imported within the package, review its callers' impact when changing that boundary. Keep changes compatible with ESM and the explicit export map in `package.json`.

## Route a change

| Change | Start with | Validation or adjacent context |
| --- | --- | --- |
| Package entry, exports, or DSH wiring | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`cordis.patch.yml`](cordis.patch.yml), `npm test` |
| Shared or model-specific connector work | [`src/connectors.mjs`](src/connectors.mjs) | [`src/codex.mjs`](src/codex.mjs), [`src/grok.mjs`](src/grok.mjs), [`src/qwen.mjs`](src/qwen.mjs) |
| Response handling | [`src/responses.mjs`](src/responses.mjs) | [`tests/responses.mjs`](tests/responses.mjs) |
| Grok auto-continuation | [`src/grok-auto-continue.mjs`](src/grok-auto-continue.mjs), [`src/grok.mjs`](src/grok.mjs) | [`tests/auto-continue.mjs`](tests/auto-continue.mjs) |
| Login command or exported login surface | [`bin/login.mjs`](bin/login.mjs), [`src/login.mjs`](src/login.mjs) | Related modules: [`src/oauth.mjs`](src/oauth.mjs), [`src/pi-auth.mjs`](src/pi-auth.mjs), [`src/store.mjs`](src/store.mjs) |

For package boundaries, commands, and shipped files, treat [`package.json`](package.json) as the authoritative index.
