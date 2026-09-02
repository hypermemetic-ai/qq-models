# `@hypermemetic-ai/qq-models`

Named model connectors for the core DSH host. This is a private ECMAScript-module package; its default entry point is [`src/plugin.mjs`](src/plugin.mjs), and its DSH bundle patch is [`cordis.patch.yml`](cordis.patch.yml).

## Run the established checks

```sh
npm test
```

That script syntax-checks the plugin and then runs [`tests/responses.mjs`](tests/responses.mjs), [`tests/auto-continue.mjs`](tests/auto-continue.mjs), [`tests/auth-store.mjs`](tests/auth-store.mjs), and [`tests/dsh-alpha4.mjs`](tests/dsh-alpha4.mjs). The package declares no start script. It also exposes the installed `qq-models-login` executable from [`bin/login.mjs`](bin/login.mjs).

## Repository map

- [`src/plugin.mjs`](src/plugin.mjs) is the package's main and default export; start here for host/plugin integration.
- [`src/connectors.mjs`](src/connectors.mjs) is the public connectors subpath and the most widely imported relative module in the repository. Connector-named implementation files include [`src/codex.mjs`](src/codex.mjs), [`src/grok.mjs`](src/grok.mjs), and [`src/qwen.mjs`](src/qwen.mjs); only Qwen also has its own declared package subpath.
- Authentication and local state are split across the public [`src/login.mjs`](src/login.mjs) and [`src/store.mjs`](src/store.mjs) modules, with supporting [`src/oauth.mjs`](src/oauth.mjs) and [`src/pi-auth.mjs`](src/pi-auth.mjs) sources.
- The remaining declared subpaths are [`src/home.mjs`](src/home.mjs) and [`src/command.mjs`](src/command.mjs). The complete export map and dependency versions live in [`package.json`](package.json).

## Route common changes

| Change | Start with | Established check |
| --- | --- | --- |
| Plugin or DSH integration | [`src/plugin.mjs`](src/plugin.mjs), [`cordis.patch.yml`](cordis.patch.yml) | [`tests/dsh-alpha4.mjs`](tests/dsh-alpha4.mjs) |
| Response handling | [`src/responses.mjs`](src/responses.mjs) | [`tests/responses.mjs`](tests/responses.mjs) |
| Grok auto-continuation | [`src/grok-auto-continue.mjs`](src/grok-auto-continue.mjs), [`src/grok.mjs`](src/grok.mjs) | [`tests/auto-continue.mjs`](tests/auto-continue.mjs) |
| Authentication or stored credentials | [`src/login.mjs`](src/login.mjs), [`src/store.mjs`](src/store.mjs) | [`tests/auth-store.mjs`](tests/auth-store.mjs) |
| Shared connector surface | [`src/connectors.mjs`](src/connectors.mjs) | Run the full `npm test` suite |

Treat [`package.json`](package.json) as authoritative for the public module surface: the declared subpaths are `.`, `home`, `store`, `connectors`, `command`, `login`, and `qwen`.
