# The cli Transport only; the sdk Transport is removed

Supersedes [ADR-0006](0006-sdk-transport.md).

ADR-0006 added a second Transport per Backend, the vendor SDKs, and preferred it over the CLI. This ADR removes that. A Backend is reached by spawning its CLI, and nothing else. The server is a plain wrapper: request in, CLI spawned, response out.

## Why the sdk Transport goes

Measured on the same Model (claude-haiku), with the same system prompt, on a subscription login, the sdk Transport was the heaviest of the variants tested (see the table below). Its `allowedTools: []` blocks tool use but leaves the tool definitions in the prompt, so it paid for them. The CLI's `--tools ""` removes them.

The SDK path also carried costs that the CLI path did not: a second copy of each binary bundled through npm, a codex session file written per Turn, a boot-time translation table for raw flags, and a fallback that depended on whether a package could be imported. Removing it removes all four.

## Measurement

Method: `claude` 2.1.310, Haiku (`claude-haiku-5-5`), subscription login (`apiKeySource: "none"` in every run), system prompt "You are a helpful assistant.", message "hello", warm cache, 2 runs per variant. Prompt total is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. The server's own `usage.prompt_tokens` reports only `input_tokens`, which excludes cached prompt tokens, so it understates overhead by two to three orders of magnitude here (it reads 2 to 10 where the totals are 599 to 13,871), and was not used for comparison. Raw numbers: `measure.txt` in the session scratchpad.

| Variant | Tools offered | Prompt total | Output |
| --- | --- | --- | --- |
| A. cli, ADR-0002 strip (`--allowed-tools ""`) | 23 | 9,405 | 33-36 |
| B. cli, Sphinx-style (`--tools ""`, `--safe-mode`, `--no-session-persistence`, `--no-chrome`) | 0 | 599 | 34-40 |
| D. sdk, the options the sdk Backend passed (`allowedTools: []`, `settingSources: []`, `mcpServers: {}`) | 37 | 13,871 | 112-143 |
| E. cli, new default access (`--tools Read,Glob,Grep`) | 3 | 3,248 | |
| G. cli, web on (`--tools Read,Glob,Grep,WebSearch,WebFetch`) | 5 | 4,232 | |

Notes on these numbers:

- Variant B is the cheapest of the set that works on subscription login. The sdk variant (D) was not re-tried with Sphinx-style flags: its options have no equivalent of `--tools ""`, so the comparison that matters is cli-with-`--tools ""` (B) against sdk (D), and that comparison is the reason for the removal.
- ADR-0006 recorded 13,795 (cli) and 12,596 (sdk). Those figures were taken on an earlier basis and are not reproduced by the method above, so they are not compared directly here.
- Two runs per variant on warm cache, one Model, one system prompt. These are measurements of the shape of the difference, not a benchmark.

## Decisions

**The cli Backend's harness strip is Sphinx's.** `--safe-mode --no-session-persistence --no-chrome --tools <list>`, with `--allowed-tools` set to the same list. `--tools` decides what is offered; `--allowed-tools` only pre-approves it. Which names are offered depends on the request's `access` and `web` (see below), and is empty for a request that asks for nothing.

**Default access is `none`: no file tools.** `access: "none"` is the default for claude Models. codex Models have no `none`: their default is `read-only`. For claude it passes `--tools ""` (variant B above: 0 tools, about 0.6k prompt tokens). `access: "read-only"` offers `Read`, `Glob` and `Grep` (variant E, about 2.6k tokens over B); `workspace-write` adds `Edit` and `Write`. The earlier default offered read tools, which made a plain request pay for them. The cost of `read-only` is recorded here rather than hidden.

codex has no tool-less mode, so `none` is not offered for codex at all: its values are `read-only` (default, `-s read-only`) and `workspace-write` (`-s workspace-write`). A codex `read-only` Turn still reads files outside the workdir, and only its writes are blocked. This is documented on the option, not hidden behind a name.

**Child environment is scrubbed the way Sphinx scrubs it.** `childEnvironment` in `src/backends/cli.ts` drops the API-key variables for the Backend (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, and the Bedrock/Vertex/Foundry switches), so the subscription login answers. It also drops `GIT_*`, `CLAUDECODE`, and the parent-session patterns Sphinx uses, and sets `NO_COLOR=1`. The live suite starts the server with a bogus `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; the claude call still answers, which is the check that the key is not passed through.

**Working directory is server config, not the server's cwd.** `WORKDIR_DEFAULT` is the directory a Turn runs in when the request names none. Each Turn's cwd is passed to the CLI both as the spawn `cwd` and, for codex, as `-C`. A request's `workdir` is accepted only if it is absolute and its realpath is equal to, or inside, a realpath in `WORKDIR_ROOTS` (the default directory is always included). `..` segments and symlinks are resolved before the check. Anything else is a 400.

**Access.** `none` (claude's default), `read-only` and `workspace-write` are per request, and a Model must declare the value. Mapping: codex uses `-s read-only` for `read-only` and `-s workspace-write` for `workspace-write`; claude uses the tool sets above (`toolsFor` in `src/backends/claude.ts`).

**Access is not a sandbox on claude.** This is stated plainly because the option names suggest otherwise. For claude, `read-only` and `workspace-write` are not confinement:

- `Read`, `Glob`, `Grep`, `Edit` and `Write` accept absolute paths. A `read-only` Turn can read any file the server's user can read, and a `workspace-write` Turn can write any such file.
- The Turn's `workdir` only sets the process's working directory. It does not limit which paths a tool may name.
- `WORKDIR_ROOTS` only restricts which directory a request may name as its `workdir`. It does not restrict what the tools touch once the Turn runs.

codex is different in one direction only. `workspace-write` confines writes to the workdir (its sandbox enforces this). codex `read-only` still reads outside the workdir: the sandbox limits writes, not reads.

Sphinx avoids the problem by giving the bin no file access at all: `claude --tools ''`, codex with `shell_tool=false`, and an empty tmpdir as its cwd. This server offers the file tools when `read-only` or `workspace-write` is asked for, so it does not provide that guarantee. Clients that need a hard boundary should use `none`, which for claude removes every file tool, or should not expose the server to untrusted prompts.

**Web is off by default and per Model.** claude gets `WebSearch` and `WebFetch` in its tool set. codex gets `-c web_search="live"` when on and `-c web_search="disabled"` when off, set explicitly so a user's own `~/.codex` config cannot enable it for a request that did not ask.

**Structured output.** `response_format: {type: "json_schema", json_schema: {name, schema, strict?}}` is the only accepted format; anything else is a 400. claude receives the schema as `--json-schema <json>` and returns the conforming JSON in `result`. codex receives it as `--output-schema <file>`; the file lives in a per-Turn temp directory that is removed when the process finishes. `strict` is validated as a boolean and not otherwise used, since neither CLI exposes a separate strict mode.

**Per-Model options are declared per Backend, and a Model can override one.** Each Backend's `reasoning_effort`, `web`, `access` and `workdir` declarations (`supported`, `values`, `default`, description) live in `BACKEND_OPTION_DEFAULTS` in `src/config.ts`. A `models.json` entry names only what differs: its own `options` object replaces the option it names. Validation runs at boot. An unsupported option must declare its neutral default (`reasoning_effort` and `workdir`: null, `web`: false, `access`: `none`), and `workdir` must always default to null. `/v1/models` and `/v1/models/{id}` return that declaration under `local_ai_wrapper.options`. A request that names an option the Model does not declare is a 400. This replaces the cross-check ADR-0005 chose not to make: a `reasoning_effort` value is now checked against the resolved Model's own list, not against the union of both backends.

**`args` are gone from `models.json`.** A raw escape hatch cannot be checked, and the flags it carried are now the Backend's own. Each Backend applies its own strip and option flags.

## Tool calling

`tools`, `functions` and `tool_choice` are all rejected with a 400. Dropping `tool_choice` from the accepted set is the only change from before, and it follows from the same reason as `tools` and `functions`.

## Known deviations

- **`gpt-5.6-sol` is rejected for real calls on this account.** Codex answers `The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account`, with or without the new flags. The live suite therefore makes its real codex calls on `codex-luna`. `codex-sol` still appears in discovery and in the guard checks, which make no call.
- The `web` default-off behaviour is asserted by unit test (`test/claudeTools.test.ts`), not over HTTP, because the tool list cannot be read back through the API.
