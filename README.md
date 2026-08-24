# localAIWrapper

An OpenAI-compatible HTTP server that fronts local coding agents (`claude`, `codex`) so they look like plain chat models to any OpenAI-compatible client. Zero server-side state, tools disabled.

See `CONTEXT.md` for the project's vocabulary (Backend, Model, Transport, Turn) and `docs/adr/` for why the server works the way it does.

## Installing

```sh
bun install
```

Each Backend is reached through one of two Transports: `sdk`, the vendor's own library (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`), or `cli`, spawning the `claude`/`codex` binary directly and parsing its output, as this project originally did. Preference is `sdk`, falling back to `cli` only when the vendor package isn't installed. `bun install` pulls in both SDKs, so it is now a required step — see docs/adr/0006 for what changed and why.

## Starting the server

```sh
bun run src/server.ts
```

The server binds to `127.0.0.1` only, on the port given by the `PORT` environment variable:

```sh
PORT=8080 bun run src/server.ts
```

There is no authentication.

## Pointing a client at it

Any OpenAI-compatible client works by setting its base URL to this server and picking one of the configured Models by name, e.g.:

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet",
    "messages": [{ "role": "user", "content": "hello" }]
  }'
```

Add `"stream": true` to get an SSE stream of `chat.completion.chunk` frames instead of a single JSON response.

Every request is serviced by a fresh Turn, on whichever Transport the Model resolved to — a freshly spawned CLI process, or a fresh call through the vendor SDK. Either way the server holds no state between requests, so the client's full `messages` array is sent on every call (see ADR-0001).

One exception: the codex SDK writes a session file per Turn to `~/.codex/sessions`, even though nothing is ever read back from it — a fresh thread is started on every Turn and `resumeThread()` is never called, so ADR-0001's statelessness still holds in practice. It's a disk-cost regression against the cli Transport, not a state leak (see docs/adr/0006).

`GET /v1/models` lists every configured Model, and `GET /v1/models/{id}` returns that same object for one Model by name. Beyond the standard OpenAI fields, each object carries a `local_ai_wrapper` key with this server's own metadata (backend, underlying LLM, streaming behaviour, accepted options) — see ADR-0004 for why that lives in a namespaced key instead of at the top level, and why there is no Ollama-compatible discovery surface.

## Adding a Model

Models are declared in `models.json`, not in code. Each entry names a Backend (which coding agent it drives) plus that agent's invocation settings — the underlying LLM alias, and a raw `args` array of extra CLI-style flags appended verbatim to the invocation.

An optional `"transport"` field pins a Model to `"cli"`, skipping the sdk Transport even when the vendor package is installed. This is required for a Model whose `args` can't be translated into SDK options — an unrecognised flag is a startup error, not a silent drop (see docs/adr/0006) — and otherwise useful for keeping a Model on the spawn path deliberately. Omitting `"transport"` means "prefer sdk, fall back to cli only if the vendor package won't import."

To add a Model, add an entry to `models.json`; no source change is required, and the new Model shows up in `GET /v1/models` immediately. To see what a Backend actually supports on either Transport, check the corresponding Backend file — nothing outside it should know that agent's flags, binary name, or SDK options.
