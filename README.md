# `@hypermemetic-ai/qq-models`

Private ESM package providing named model connectors for the core DSH host. Its package root and `main` entry both resolve to [`src/plugin.mjs`](src/plugin.mjs).

## Test

The repository declares one task:

```sh
npm test
```

It syntax-checks the plugin and runs focused Responses diagnostics/recovery tests under [`tests/`](tests/).

## Repository map

| Boundary | Start here |
| --- | --- |
| Package identity, entry points, and shipped files | [`package.json`](package.json) |
| Root plugin entry | [`src/plugin.mjs`](src/plugin.mjs) |
| Public module entry points | [`src/connectors.mjs`](src/connectors.mjs), [`src/command.mjs`](src/command.mjs), [`src/home.mjs`](src/home.mjs), [`src/store.mjs`](src/store.mjs), [`src/login.mjs`](src/login.mjs), and [`src/qwen.mjs`](src/qwen.mjs) |
| `qq-models-login` executable | [`bin/login.mjs`](bin/login.mjs) |
| DSH bundle patch | [`cordis.patch.yml`](cordis.patch.yml) |

The public subpath exports are `./connectors`, `./command`, `./home`, `./store`, `./login`, and `./qwen`; [`package.json`](package.json) is authoritative for that surface. The package is ESM (`"type": "module"`).

## Route a change

- **Root loading or plugin wiring:** begin with [`src/plugin.mjs`](src/plugin.mjs), then run the declared test.
- **Public module behavior:** begin with the source mapped to that subpath above. [`src/connectors.mjs`](src/connectors.mjs) has the highest relative-import fan-in in the repository, so changes there deserve broader impact review.
- **A model-named implementation:** use the matching tracked source when one exists: [`src/codex.mjs`](src/codex.mjs), [`src/grok.mjs`](src/grok.mjs), or [`src/qwen.mjs`](src/qwen.mjs). The evidence establishes these locations, not their runtime relationships.
- **Login surfaces:** route the exported `./login` module to [`src/login.mjs`](src/login.mjs) and the named executable to [`bin/login.mjs`](bin/login.mjs).
- **Exports, executable mapping, or bundle contents:** update [`package.json`](package.json); DSH patch changes belong in [`cordis.patch.yml`](cordis.patch.yml).

## Provider failure behavior

Grok and Codex Responses requests retry bounded transient transport failures before any model output is exposed. Terminal failures retain a redacted, bounded HTTP status, upstream error code, response ID, and request ID when the provider supplies them. If all in-request retries fail, live Grok/Codex chairs schedule bounded continuation turns with exponential backoff rather than leaving the operator at one opaque provider error. Authentication, invalid-request, policy, and caller-abort failures never auto-continue.

Validate connector changes with the declared tests and the relevant host or consumer workflow.
