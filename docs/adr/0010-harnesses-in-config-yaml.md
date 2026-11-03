# Harnesses in config.yaml select the account by Model name

One server process used to mean one account per CLI, because every Turn was spawned with the server's own environment. Clients such as DeepTutor and LearnHarness send only an OpenAI `model` name, so they need the account to be part of that name.

## Decision

An optional repo-root `config.yaml` (gitignored; `config.example.yaml` is committed) declares **Harnesses** (see CONTEXT.md): `adapter` (`claude`, `codex` or `commandcode`), `env`, and an optional `bin`. `models.json` is unchanged and still defines the base Models.

- **Selection is by Model name prefix.** At boot each Harness copies every `models.json` Model of its adapter as `<harness>-<suffix>` (the Model name minus its `<adapter>-` prefix), with the same options, system prompt and context window, plus `env` and `bin`. These join the one `models` record, so routing and `GET /v1/models` need no special case. No new request field is added: a client that can only send a model name can still choose.
- **commandcode** Models are not in `models.json` (ADR 0008), so `<harness>/<id>` is accepted and resolved like `commandcode/<id>`, then spawned with the Harness env.
- **Env values** are text or `{file: path}`. A file is read at spawn (trimmed, `~` expanded), not at boot, so a rotated token needs no restart. The result is merged over the cleaned child environment, so a Harness may set a variable the cleaning would strip. Errors name the variable and path; values are never logged or echoed, including in validation errors.
- **Validation at boot** fails naming the Harness: unknown adapter or key, a non-string env value or malformed `{file}`, an invalid variable name, or a name that collides with a `models.json` Model, another Harness, or the `commandcode` prefix. A missing `config.yaml` changes nothing.
- The file is parsed with Bun's built-in `Bun.YAML.parse`, keeping the project free of dependencies.

## Consequences

- Changing `config.yaml` needs a restart. Token files do not.
- A Harness adds one Model per base Model of its adapter, so `GET /v1/models` grows with the number of Harnesses.
- `GET /v1/commandcode/models` (the catalog listing) and the catalog fallback still run with the default environment. A Harness with a different commandcode account may therefore see a catalog that differs from the listing.
- Harness env is a trust boundary of the operator: anyone who can call the server can use any configured account. The server still has no authentication (bind to loopback).
- A relative `{file: path}` is read relative to the server's working directory, so use an absolute path or `~/...` (only a leading `~` is expanded).
- YAML keeps the last of two identical keys, so a duplicated harness name silently replaces the earlier one. Keep harness names unique.
- A failed env read returns the variable name and file path (never the value) in the 502 error.
