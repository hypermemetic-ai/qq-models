# `@hypermemetic-ai/qq-models`

One repository, one plugin, one version. Loading this plugin is how a DSH
host connects language models. qq expects it and still runs if it is absent.
The start script already binds `qq-*` siblings; this package is not named in
`bin/qq` or `host.patch.yml`.

The job is connectors, not subscriptions. First land ships `grok`, `codex`,
and the leftover Qwen key route. A later local box is the same kind of
thing: a named connector this plugin can attach.

## Connectors

| Connector | Route | Kind | First model |
|---|---|---|---|
| `grok` | `xai-auth` | OAuth device code | `grok-4.6` |
| `codex` | `openai-codex` | OAuth device code | `gpt-5.6-sol` |
| `qwen` | `qwen-token-plan` | host key | `deepseek-v4-pro-0813` |

Qwen stays on the host recipe. Picking qwen does not start OAuth.

Grok (`xai-auth`) speaks the OpenAI Responses proxy. DSH tool schemas are
sent as Responses function tools under their DSH names. Tool-call history
round-trips as `function_call` / `function_call_output`. The adapter does
not remap names and does not add provider-hosted search tools. DSH still
executes tools.

### Prompt-cache maximization (Grok)

xAI caches from the start of the request, so the directive is two parts:
keep the request pinned to one server *and* keep the prefix byte-stable.

- `prompt_cache_key` is stamped from the loop's `sessionId` (never invented
  per request), matching the `x-grok-conv-id` / `x-grok-session-id` headers.
- Each Grok response requests `reasoning.encrypted_content`. Captured
  reasoning is replayed back as the same legal `reasoning` input item via the
  `finish` chunk's `ReplayEnvelope`, so the next turn does not drop or rephrase
  encrypted reasoning and break the cached prefix.

Old/foreign assistant messages without the `xai-auth` replay envelope skip
reasoning as before; the harness keeps each envelope opaque and only returns it
to the same provider's adapter.

Codex (`openai-codex`) and Qwen (`qwen-token-plan`) need no equivalent: the
Codex backend is an OpenAI Responses surface with automatic prompt caching, so
there is no server-affinity key to stamp, and Qwen stays on the host recipe.

## `/login` and `/logout`

Bare `/login` is a phone sheet of pressable connector names. Named
`/login grok` starts that connector's device-code flow and returns at once
with the verification URL and user code. Approval writes the plugin file in
the background.

Logout deletes this host's file for that connector. It does not cancel the
account. `/logout qwen` does not delete the host key.

## Store

Plugin-owned files under `$DSH_HOME` (honors `QQ_DSH_HOME` / `DSH_HOME`):

- `$DSH_HOME/.qq-grok-auth.json`
- `$DSH_HOME/.qq-codex-auth.json`

Mode `0600`. Atomic write. Refresh locked per file.

## Terminal bootstrap

When nothing is listening:

```
qq-login grok
qq-login codex
qq-login status
qq-login logout grok
```

Same store and flows as the slash. Named arguments only.
