# localAIWrapper

An OpenAI-compatible HTTP server that shells out to local coding-agent CLIs (`claude`, `codex`) so they look like plain chat models to any OpenAI-compatible client. Zero dependencies, zero server-side state, tools disabled.

See `CONTEXT.md` for the project's vocabulary (Backend, Model, Turn) and `docs/adr/` for why the server works the way it does.

## Starting the server

```sh
bun run src/server.ts
```

The server binds to `127.0.0.1` only, on the port given by the `PORT` environment variable:

```sh
PORT=8080 bun run src/server.ts
```

There is no authentication and no third-party dependencies to install.

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

Every request is serviced by a fresh CLI process — the server holds no state between requests, so the client's full `messages` array is sent on every call (see ADR-0001).

`GET /v1/models` lists every configured Model, and `GET /v1/models/{id}` returns that same object for one Model by name. Beyond the standard OpenAI fields, each object carries a `local_ai_wrapper` key with this server's own metadata (backend, underlying LLM, streaming behaviour, accepted options) — see ADR-0004 for why that lives in a namespaced key instead of at the top level, and why there is no Ollama-compatible discovery surface.

## Adding a Model

Models are declared in `models.json`, not in code. Each entry names a Backend (which CLI it drives) plus that CLI's invocation settings — the underlying LLM alias, and a raw `args` array of extra flags appended verbatim to the invocation.

To add a Model, add an entry to `models.json`; no source change is required, and the new Model shows up in `GET /v1/models` immediately. To see what a Backend actually supports, check the corresponding Backend file — nothing outside it should know that CLI's flags or binary name.
