# localAIWrapper

An OpenAI-compatible HTTP server that fronts local coding agents (`claude`, `codex`) so they look like plain chat models to any OpenAI-compatible client. Each request spawns the agent's CLI and returns its answer; the server holds no state between requests.

See `CONTEXT.md` for the project's vocabulary (Backend, Model, Turn, Workdir, Access) and `docs/adr/` for why the server works the way it does.

## Installing

Requires [Bun](https://bun.sh), and the `claude` and `codex` CLIs on `PATH`, logged in with your subscription.

```sh
bun run start
```

There are no dependencies to install. Each Backend is reached by spawning its CLI (see docs/adr/0007).

## Starting the server

```sh
bun run src/server.ts
```

The server binds to `127.0.0.1` only, on the port given by the `PORT` environment variable:

```sh
PORT=8080 bun run src/server.ts
```

There is no authentication.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on. |
| `WORKDIR_DEFAULT` | `~/.local/share/localAIWrapper/workdir` | Directory every Turn runs in unless the request names another. Created at startup if it is the default and missing; if you set it, it must already exist. |
| `WORKDIR_ROOTS` | (empty) | Comma-separated directories a request's `workdir` may resolve into. `WORKDIR_DEFAULT` is always included. Each entry must exist. |
| `MAX_CONCURRENCY` | `4` | Most CLI processes running at once. Requests past this queue. |
| `TURN_TIMEOUT_MS` | `600000` | Per-Turn budget, including queue wait. Exceeding it kills the process and returns a 504. |

Each Turn runs in the default directory, not in the directory the server was started from. `WORKDIR_ROOTS` only limits which directory a request may name as its `workdir`. It does not sandbox the agent: a claude Turn with `read-only` or `workspace-write` can read and write files anywhere its user can, and a codex Turn can read anywhere (only codex writes are confined). The default `access` for claude is `none`, which removes its file tools.

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

Every request is serviced by a fresh Turn: a freshly spawned CLI process. The server holds no state between requests, so the client's full `messages` array is sent on every call (see ADR-0001).

## Per-request options

Options are request fields. Each Model declares which it supports; see `local_ai_wrapper.options` on `GET /v1/models/{id}` for the exact values and defaults. Asking for an option the Model does not support, or a value outside its list, returns a 400.

| Field | Values | Default | What it does |
| --- | --- | --- | --- |
| `reasoning_effort` | per Model (claude: `low`–`max`; codex: `minimal`–`high`) | backend default | Passed to the CLI as its reasoning-effort setting. |
| `web` | `true` / `false` | `false` | Allows web search and page fetch. claude: `WebSearch`, `WebFetch`. codex: `web_search=live`. |
| `access` | claude: `none` / `read-only` / `workspace-write`; codex: `read-only` / `workspace-write` | claude: `none`; codex: `read-only` | claude: `none` removes every file tool. `read-only`: claude gets `Read`, `Glob`, `Grep`; codex gets its read-only sandbox. `workspace-write`: claude also gets `Edit` and `Write`; codex may write inside its Workdir. codex has no `none`. **Not a sandbox for claude**: its file tools accept absolute paths, so `read-only` and `workspace-write` can reach files outside the Workdir. For codex, `read-only` can still read files outside the Workdir; only writes are confined (`workspace-write` confines writes). See docs/adr/0007. |
| `workdir` | absolute path | `WORKDIR_DEFAULT` | Directory the Turn runs in. Must resolve (after `..` and symlinks) inside `WORKDIR_ROOTS`. |
| `response_format` | `{"type":"json_schema","json_schema":{"name":"…","schema":{…}}}` | none | The answer's content is JSON matching the schema. `{"type":"text"}` is accepted as a no-op (no constraint). Any other `type` is a 400. |

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-luna",
    "workdir": "/Users/me/scratch/project",
    "access": "workspace-write",
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "answer",
        "schema": {"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}
      }
    },
    "messages": [{ "role": "user", "content": "Create notes.txt, then report ok." }]
  }'
```

`tools`, `functions` and `tool_choice` are rejected with a 400. This server does not do tool calling.

`GET /v1/models` lists every configured Model, and `GET /v1/models/{id}` returns that same object for one Model by name. Beyond the standard OpenAI fields, each object carries a `local_ai_wrapper` key with this server's own metadata: backend, underlying LLM, streaming behaviour, context window and the per-option declarations above. See ADR-0004 for why that lives in a namespaced key, and why there is no Ollama-compatible discovery surface.

## Adding a Model

Models are declared in `models.json`, not in code. Each entry names a Backend (which coding agent it drives), the underlying LLM alias, and an optional `systemPrompt` and `contextWindow`. Its options come from the Backend's shared declarations in `BACKEND_OPTION_DEFAULTS` (`src/config.ts`). A Model may override any one option by naming it in an `options` object. Each option declares, for `reasoning_effort`, `web`, `access` and `workdir`:

- `supported` (boolean)
- `values` (the allowed values, or `null` for free-form `workdir`)
- `default` (what applies when the request omits the option, or `null`)
- `description` (one line, shown on `/v1/models`)

```json
"claude-haiku": {
  "backend": "claude",
  "model": "haiku",
  "systemPrompt": "You are a helpful assistant.",
  "contextWindow": 200000
}
```

There is no raw `args` escape hatch. Each Backend applies its own flags, so the harness strip, sandbox and billing setup cannot be overridden per Model (see docs/adr/0007).

To add a Model, add an entry to `models.json`; no source change is required, and the new Model shows up in `GET /v1/models` immediately. The server refuses to start if a Model is malformed or names an unknown Backend.
