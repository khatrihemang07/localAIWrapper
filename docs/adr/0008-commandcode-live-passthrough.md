# commandcode Models are a live pass-through of the CLI's catalog

commandcode is the third Backend. Its catalog has about 93 models that the vendor changes often, and the CLI refreshes it from the server about every 15 minutes. Its Models are therefore not written into `models.json`. A client names any catalog model as `commandcode/<id>`, and the server resolves the name against the CLI's catalog on each request. These are **Pass-through Models** (see CONTEXT.md).

## Why not generated entries

A generated `models.json` would go stale within a catalog refresh, and every change to the catalog would need a config edit and a restart. Resolving live costs one file read per request (and a `commandcode --list-models` run only when the cache is missing), and keeps the server's list equal to what the CLI will actually accept.

## Where the metadata comes from

- The reasoning efforts and context window of each model are read from the CLI's own cache, `~/.commandcode/cache/model-catalog/v1/catalog-*.json`, which the CLI keeps for itself. The newest file by `fetchedAt` is used, as it stands. There is no freshness check and no server-side TTL.
- Hidden catalog entries are left out. The CLI refuses them ("no longer available"), so they are not resolvable.
- If the cache is missing or unreadable, the server falls back to `commandcode --list-models`. That listing carries no efforts or context window, so `reasoning_effort` is refused and `local_ai_wrapper.contextWindow` is omitted.
- Discovery (`GET /v1/commandcode/models`) always runs `--list-models` and merges in the cache metadata for each row.

The cache path and its JSON shape are the CLI's private format, verified against v1.88.0 only. A change in either shows up as the fallback, or as a 502 from the listing, not as a silent wrong answer.

## Names

The name after the prefix matches a full id first, then a short name (the text after the id's last `/`). Matching ignores case, because the CLI does too and its listing shows some ids in lowercase. A short name that matches more than one id is a 400 that lists the full candidates. An unknown name is a 404 with the code `model_not_found`.

## Options

- `access` accepts `read-only` only. commandcode runs headless without `--yolo`, which is the only switch that enables writes. A live check showed a write attempt blocked with `tool_hook_blocked`. `none` and `workspace-write` are refused, since nothing confines the Turn to its workdir.
- `web` is unsupported. Its web search and page fetch cannot be turned off in the CLI, so `web: true` is a 400 and `web: false` is accepted as the neutral default.
- `response_format` is unsupported. A Backend that cannot constrain its answer returns a 400, rather than an unconstrained answer presented as a constrained one.
- `reasoning_effort` is checked against the efforts the catalog lists for that model, and passed as `--effort`. A model whose catalog lists none refuses it.
- `workdir` is the spawn `cwd`, under the same `WORKDIR_ROOTS` rule as the other Backends.

## Costs and limits

- Each Turn carries the CLI's default system prompt and tool definitions. In probes with a one-word prompt, the prompt was about 12.7k to 14k input tokens, and it cannot be reduced from this side.
- Reads are not confined to the workdir: a `read_file` of a file outside it by absolute path succeeded in a probe. Reads of some paths (`/etc/hosts`) were denied, but that is the CLI's own gate, not a boundary this server provides.
- `--yolo` is never passed, and it is the only way to allow writes. Enabling it would remove the only write gate, so it is not offered.
- The child environment drops `COMMAND_CODE_API_KEY`, so the login answers. Session markers (`CMD_SESSION*`, `CMD_PARENT*`, `COMMAND_CODE_SESSION*`, `COMMAND_CODE_PARENT*`) are dropped too. Other `CMD_*` and `COMMAND_CODE_*` variables are passed through, because many of them are the user's own settings (for example `CMD_LOCAL_ONLY`).
- The live `--list-models` output and the cache can disagree on id case (`moonshotai/kimi-k2.5` in the listing, `moonshotai/Kimi-K2.5` in the cache). The server matches case-insensitively, and passes the id in the case the cache gives.

## Decisions

- Streaming is on: the CLI emits `text_delta` events, which become content chunks as they arrive.
- Concurrency is shared with the other Backends through the same semaphore (`MAX_CONCURRENCY`).
- A client's system message is prepended to the prompt, as with codex, because a pass-through Model has no `systemPrompt` of its own.
