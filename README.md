# localAIWrapper

A small local server that takes a chat request (**x**), runs it through the `claude`, `codex` or `commandcode` CLI on your machine, and returns the answer (**y**) in the standard OpenAI chat-completions format. Any OpenAI-compatible client can use it by changing its base URL.

```
your client  ──POST /v1/chat/completions──▶  localAIWrapper  ──spawns──▶  claude / codex / commandcode CLI
             ◀──────── OpenAI-style JSON ───                 ◀── answer ──
```

- One request = one fresh CLI process. The server keeps no state between requests.
- It uses your logged-in `claude` / `codex` / `commandcode` subscription, so no API key is needed.
- It is a wrapper, not an agent harness: it does not do tool calling. Your client (or harness) owns any tool loop.

Vocabulary (Backend, Model, Turn, Workdir, Access) is in `CONTEXT.md`. The reasoning behind the design is in `docs/adr/`.

## Contents

1. [Quick start](#quick-start)
2. [Examples: input and output](#examples-input-and-output)
3. [Per-request options](#per-request-options)
4. [Configuration](#configuration)
5. [Available models and discovery](#available-models-and-discovery)
6. [Errors](#errors)
7. [Adding a Model](#adding-a-model)
8. [Development](#development)

## Quick start

**You need:** [Bun](https://bun.sh), plus the `claude`, `codex` and/or `commandcode` CLIs on your `PATH`, already logged in. There are no packages to install.

**1. Check the CLIs work on their own**

```sh
claude --version
codex --version
commandcode --version
```

**2. Start the server**

```sh
bun run start
```

It listens on `http://127.0.0.1:8080` (local only, no authentication). To use another port:

```sh
PORT=9000 bun run start
```

**3. Check it is up**

```sh
curl http://127.0.0.1:8080/health
```
```json
{"status":"ok"}
```

**4. Send a request**

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-haiku",
    "messages": [{ "role": "user", "content": "Say hello in five words." }]
  }'
```
```json
{
  "id": "chatcmpl-62c20edf-c856-48e6-b852-684907cabda7",
  "object": "chat.completion",
  "created": 1792907253,
  "model": "claude-haiku",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Hello, friendly world, nice!" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 2, "completion_tokens": 14, "total_tokens": 16 }
}
```

The answer is at `choices[0].message.content`.

**Using an OpenAI SDK or app:** set its base URL to `http://127.0.0.1:8080/v1`, use any non-empty API key (it is ignored), and set the model to one of the names under [Available models](#available-models-and-discovery). Wrapper-specific options (below) are extra body fields; in the OpenAI SDKs they go in `extra_body` (Python) or as extra properties on the request (JS).

## Examples: input and output

Each example shows the request body you send and the response you get back. All use `POST http://127.0.0.1:8080/v1/chat/completions`. These outputs were captured from a running server; model wording will vary.

### 1. Plain chat (no tools, no files)

This is the default: the model only sees your messages.

Input:
```json
{
  "model": "claude-haiku",
  "messages": [
    { "role": "system", "content": "You answer in one short sentence." },
    { "role": "user", "content": "What is Bun?" }
  ]
}
```
Output: the same shape as the quick start, with the answer in `choices[0].message.content`.

A `system` message replaces the Model's configured system prompt for that request. Send the whole conversation in `messages` on every call, because the server remembers nothing.

### 2. Streaming

Add `"stream": true` to receive Server-Sent Events.

Input:
```json
{
  "model": "claude-haiku",
  "stream": true,
  "messages": [{ "role": "user", "content": "Count 1 to 3." }]
}
```
Output (each `data:` line is one event):
```
data: {"id":"chatcmpl-0813…","object":"chat.completion.chunk","model":"claude-haiku","choices":[{"index":0,"delta":{"content":"1\n2\n3","role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-0813…","object":"chat.completion.chunk","model":"claude-haiku","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":7,"total_tokens":9}}

data: {"id":"chatcmpl-0813…","object":"chat.completion.chunk","model":"claude-haiku","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

- Text arrives in `delta.content`; join them in order.
- A usage chunk (empty `choices`) always arrives before the final `stop` chunk.
- `codex` Models send the whole answer in one chunk, because codex does not stream partial text.

### 3. Structured JSON output

Pass a JSON Schema in `response_format`. The reply content is JSON matching it.

Input:
```json
{
  "model": "claude-haiku",
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "capital",
      "schema": {
        "type": "object",
        "properties": { "city": { "type": "string" } },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  },
  "messages": [{ "role": "user", "content": "Capital of France?" }]
}
```
Output:
```json
{
  "id": "chatcmpl-38d524e3-…",
  "object": "chat.completion",
  "model": "claude-haiku",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "{\"city\":\"Paris\"}" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 2, "completion_tokens": 131, "total_tokens": 133 }
}
```

`content` is a string; run `JSON.parse` on it. This is how a harness gets tool-like behaviour without the wrapper doing tool calls. `{"type":"text"}` is accepted and means "no constraint"; other types are rejected.

### 4. Let the model read files (`access` + `workdir`)

By default a claude Model has no file tools at all. To let it read files in a folder, name the folder and set `access`.

Setup (one time): allow the folder when starting the server, and put a file in it.

```sh
mkdir -p ~/scratch/proj && echo "The launch code word is PLUM." > ~/scratch/proj/note.txt
WORKDIR_ROOTS=~/scratch/proj bun run start
```

Input:
```json
{
  "model": "claude-haiku",
  "access": "read-only",
  "workdir": "/Users/you/scratch/proj",
  "messages": [{ "role": "user", "content": "Read note.txt and tell me the code word." }]
}
```
Output:
```json
{
  "object": "chat.completion",
  "model": "claude-haiku",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "The code word is **PLUM**. The file says: \"The launch code word is PLUM.\"" },
      "finish_reason": "stop"
    }
  ]
}
```

`workdir` must be an absolute path inside `WORKDIR_ROOTS`. Use `"access": "workspace-write"` to also let the model create and edit files there.

> **Not a sandbox.** For claude, `read-only` and `workspace-write` give the CLI's file tools, which accept absolute paths, so they can reach any file your user can. For codex, `workspace-write` confines writes to the workdir, but `read-only` can still read outside it. Only enable `access` for prompts you trust. See `docs/adr/0007-cli-only-transport.md`.

### 5. Web access

Input:
```json
{
  "model": "claude-sonnet",
  "web": true,
  "messages": [{ "role": "user", "content": "What is the latest Bun release?" }]
}
```
`web` defaults to `false`. When `true`, claude gets `WebSearch` and `WebFetch`; codex gets live web search.

### 6. Using codex

Same request, different Model name:

Input:
```json
{
  "model": "codex-luna",
  "messages": [{ "role": "user", "content": "Say hello in five words." }]
}
```
Output:
```json
{
  "object": "chat.completion",
  "model": "codex-luna",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "Hello there, how are you?" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 10298, "completion_tokens": 66, "total_tokens": 10364 }
}
```

Which codex Models you can use depends on your ChatGPT plan; if one is rejected, the 502 error carries codex's message (see [Errors](#errors)). `usage` is whatever the CLI reports and is not comparable between Backends.

### 7. Things that are rejected

Tool calling:
```json
{ "model": "claude-haiku", "tools": [{ "type": "function" }], "messages": [{ "role": "user", "content": "hi" }] }
```
```json
{
  "error": {
    "message": "This server does not support tool calling; requests containing \"tools\", \"functions\" or \"tool_choice\" are rejected rather than silently ignored.",
    "type": "invalid_request_error",
    "code": null
  }
}
```
(HTTP 400.)

A `workdir` outside the allowed folders:
```json
{ "model": "claude-haiku", "workdir": "/etc", "messages": [{ "role": "user", "content": "hi" }] }
```
```json
{ "error": { "message": "\"workdir\" is not an allowed directory", "type": "invalid_request_error", "code": null } }
```
(HTTP 400. The same message is returned whether the path is missing, not a folder, or outside the allowed roots.)

## Per-request options

These are extra fields on the request body. Each Model declares which ones it supports (see [discovery](#available-models-and-discovery)). Asking for an unsupported option, or a value outside its list, returns a 400. Sending an option's neutral default (for example `"web": false`) is always accepted.

| Field | Values | Default | What it does |
| --- | --- | --- | --- |
| `reasoning_effort` | claude: `low`, `medium`, `high`, `xhigh`, `max`. codex: `minimal`, `low`, `medium`, `high`. commandcode: per model, listed by discovery. | CLI default | Reasoning effort passed to the CLI. |
| `web` | `true` / `false` | `false` | Allow web search and page fetch. Not available on commandcode. |
| `access` | claude: `none`, `read-only`, `workspace-write`. codex: `read-only`, `workspace-write`. commandcode: `read-only`. | claude: `none`. codex and commandcode: `read-only`. | What the agent may do with files. See the table below. |
| `workdir` | absolute path | `WORKDIR_DEFAULT` | Folder the Turn runs in. Must resolve (after `..` and symlinks) inside `WORKDIR_ROOTS`. |
| `response_format` | `{"type":"json_schema","json_schema":{"name","schema"}}` or `{"type":"text"}` | none | JSON-Schema-constrained answer. Not available on commandcode. |
| `stream` | `true` / `false` | `false` | Server-Sent Events instead of one JSON body. |

What `access` means per Backend:

| Value | claude | codex | commandcode |
| --- | --- | --- | --- |
| `none` | No file tools. Plain chat (about 0.6k prompt tokens). | not offered | not offered |
| `read-only` | `Read`, `Glob`, `Grep` | read-only sandbox | headless, so writes are blocked; reads are not confined to the workdir |
| `workspace-write` | adds `Edit`, `Write` | may write inside the workdir | not offered (no confinement) |

Other standard fields (`temperature`, `max_tokens`, …) are accepted and ignored. `tools`, `functions` and `tool_choice` are rejected.

## Configuration

Set these as environment variables when starting the server.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on (always bound to `127.0.0.1`). |
| `WORKDIR_DEFAULT` | `~/.local/share/localAIWrapper/workdir` | Folder every Turn runs in unless the request names another. Created at startup if it is the default and missing; if you set it, it must already exist. |
| `WORKDIR_ROOTS` | (empty) | Comma-separated folders a request's `workdir` may resolve into. `WORKDIR_DEFAULT` is always included. Each entry must exist. |
| `MAX_CONCURRENCY` | `4` | Most CLI processes running at once. Extra requests wait in a queue. |
| `TURN_TIMEOUT_MS` | `600000` | Per-request budget including queue wait. Exceeding it kills the process and returns a 504. |

Example with everything set:

```sh
PORT=9000 \
WORKDIR_DEFAULT=$HOME/scratch/default \
WORKDIR_ROOTS=$HOME/scratch/proj,$HOME/code/demo \
MAX_CONCURRENCY=2 \
TURN_TIMEOUT_MS=120000 \
bun run start
```

Each CLI runs with a cleaned environment: `GIT_*`, parent-agent session variables and API-key variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COMMAND_CODE_API_KEY`, ...) are removed so your subscription login is used and nothing leaks from the server's shell.

## Available models and discovery

The shipped Models (from `models.json`):

| Model | Backend | Underlying LLM |
| --- | --- | --- |
| `claude-opus` | claude | opus |
| `claude-sonnet` | claude | sonnet |
| `claude-haiku` | claude | haiku |
| `codex-sol` | codex | gpt-5.6-sol |
| `codex-terra` | codex | gpt-5.6-terra |
| `codex-luna` | codex | gpt-5.6-luna |

List them:

```sh
curl http://127.0.0.1:8080/v1/models
```

Inspect one Model, including exactly which options it supports:

```sh
curl http://127.0.0.1:8080/v1/models/claude-haiku
```
```json
{
  "id": "claude-haiku",
  "object": "model",
  "owned_by": "claude",
  "local_ai_wrapper": {
    "backend": "claude",
    "llm": "haiku",
    "streaming": true,
    "tools": false,
    "contextWindow": 200000,
    "options": {
      "reasoning_effort": { "supported": true, "values": ["low","medium","high","xhigh","max"], "default": null, "description": "…" },
      "web":              { "supported": true, "values": [false, true], "default": false, "description": "…" },
      "access":           { "supported": true, "values": ["none","read-only","workspace-write"], "default": "none", "description": "…" },
      "workdir":          { "supported": true, "values": null, "default": null, "description": "…" }
    }
  }
}
```

`local_ai_wrapper.options` is the source of truth for what a client may send to that Model. (Output shortened; descriptions elided.)

### commandcode: live Models from the CLI's catalog

commandcode Models are not in `models.json`. The catalog changes often, so a commandcode Model is named `commandcode/<id>` and resolved on each request against the CLI's own catalog. Use the full catalog id, or its short name (the text after the last `/`), which the CLI also accepts:

```json
{ "model": "commandcode/deepseek/deepseek-v4-flash", "messages": [{ "role": "user", "content": "hi" }] }
{ "model": "commandcode/deepseek-v4-flash", "messages": [{ "role": "user", "content": "hi" }] }
```

Matching ignores case. A short name shared by two ids is a 400 that lists both full ids. Use the listing to see what is available:

```sh
curl "http://127.0.0.1:8080/v1/commandcode/models?q=flash"
```

The listing is OpenAI-style. `?q=` keeps only ids that contain the text (case-insensitive):

```json
{
  "object": "list",
  "data": [
    {
      "id": "commandcode/deepseek/deepseek-v4-flash",
      "object": "model",
      "created": 1792939233,
      "owned_by": "commandcode",
      "local_ai_wrapper": {
        "backend": "commandcode",
        "short_name": "deepseek-v4-flash",
        "efforts": ["off", "high", "max"],
        "contextWindow": 1000000,
        "default": true
      }
    }
  ]
}
```

`efforts` lists what `reasoning_effort` accepts for that model. A model with no efforts refuses `reasoning_effort`. When the CLI's catalog cache is missing, `efforts` and `contextWindow` are omitted, and `reasoning_effort` is refused for every model.

Caveats specific to commandcode:
- Access is `read-only` only. Headless runs never get `--yolo`, which is the only switch that allows writes, so writes are blocked.
- `web` and `response_format` are not available. The CLI's web search cannot be turned off.
- Each Turn carries the CLI's default system prompt and tool definitions: about 12.7k to 14k input tokens for a one-word prompt in the probes behind docs/adr/0008.
- Models that the CLI refuses (hidden, or outside your plan) return the CLI's error as a 502.

See `docs/adr/0008-commandcode-live-passthrough.md`.

## Errors

Errors use the OpenAI envelope: `{"error": {"message": "…", "type": "…", "code": null}}`.

| Status | When |
| --- | --- |
| 400 | Invalid JSON, missing `model` or `messages`, no user/assistant message, `tools`/`functions`/`tool_choice`, an unsupported option or value, bad `workdir`, bad `response_format`, a commandcode short name shared by two ids (the message lists both). |
| 404 | Unknown model name (the message lists valid ones; a commandcode name gets code `model_not_found`) or unknown route. |
| 502 | The CLI could not start, or exited non-zero. The message includes the CLI's own error text. Also when the commandcode catalog cannot be listed. |
| 504 | The request exceeded `TURN_TIMEOUT_MS` (including time spent queued). |

If the client disconnects, the CLI process is killed. For streaming requests, an error after the first chunk is sent as a final `[error: …]` content chunk followed by `[DONE]`, because headers are already sent.

Troubleshooting:
- **"Failed to start claude/codex/commandcode"**: the CLI is not on the `PATH` of the shell that started the server.
- **502 mentioning login**: run the CLI by itself (`claude`, `codex login status`, `commandcode status`) and sign in.
- **Server will not start**: the message names the problem, such as a missing `WORKDIR_ROOTS` folder or a malformed `models.json` entry.

## Adding a Model

Models live in `models.json`, not in code. Add an entry and restart:

```json
"claude-haiku": {
  "backend": "claude",
  "model": "haiku",
  "systemPrompt": "You are a helpful assistant.",
  "contextWindow": 200000
}
```

- `backend`: `claude` or `codex`. (commandcode Models are not declared here; see [commandcode](#commandcode-live-models-from-the-clis-catalog).)
- `model`: the underlying LLM name the CLI understands.
- `systemPrompt` (optional): default system prompt; a request's `system` message overrides it.
- `contextWindow` (optional): reported on `/v1/models` so clients can size their context.

Option support comes from the Backend's shared declarations in `BACKEND_OPTION_DEFAULTS` (`src/config.ts`). To change one option for one Model, add an `options` object naming only that option. There is no raw CLI `args` escape hatch: each Backend applies its own flags (see `docs/adr/0007-cli-only-transport.md`). The server refuses to start on a malformed entry, an unknown key, or an unknown Backend.

## Development

```sh
bun run test:unit   # fast, no CLIs needed
bun run test        # unit tests, then ./test.sh: a live suite that starts a server and calls the real CLIs
bunx tsc --noEmit   # typecheck
```

`./test.sh` makes real `claude`, `codex` and `commandcode` calls, so it needs all three CLIs signed in and takes a few minutes.
