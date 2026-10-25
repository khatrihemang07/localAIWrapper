# The sdk Transport, preferred over cli

> Superseded by [ADR-0007](0007-cli-only-transport.md): the sdk Transport is removed and the cli Transport is the only way a Backend is reached.

Both `claude` and `codex` now ship a vendor library — `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` — that drives the same underlying binary on your behalf, handing back typed events instead of a line-oriented stdout to parse. Both SDKs still spawn a process — each bundles its own copy of the binary as a platform-specific npm package — so this is a change of interface, not of mechanism. Each Backend now offers two **Transports**: `sdk`, which imports the vendor library and reads typed events, and `cli`, which spawns the `claude`/`codex` binary and parses NDJSON off stdout, as this project has always done. Preference order is sdk, then cli, decided once per Model at startup.

This forced the `Backend` interface to change shape. It used to be `{bin, streaming, buildArgs, decode}` — process-shaped, built around producing an argv and decoding a line. An SDK Turn has no argv, no stderr, and no exit code, so `Backend` is now `{label, streaming, run(req, signal) -> TurnRun}`: a Backend owns its own execution end to end. The spawn/stderr-drain/exit-code logic that used to live inline in `src/server.ts` moved out into `src/backends/cli.ts`, where it now serves both CLI Backends as shared plumbing rather than being special-cased per request.

## Measured, on a live probe

Both SDKs authenticate against the existing subscription login with no API key. Claude's `init` message reports `apiKeySource: "none"`; codex reads `~/.codex/auth.json` and reports `auth_mode: "chatgpt"`.

| Configuration | System prompt tokens ("hello") |
| --- | --- |
| cli Transport, ADR-0002's targeted strip | 13,795 |
| sdk Transport, isolation mode (`settingSources: []`, `allowedTools: []`, `mcpServers: {}`) | 12,596 |

About 1,200 tokens, ~9%, saved. Modest, not transformative — the residual overhead is the same built-in tool *definitions* ADR-0002 already accepted; blocking tool *use* was never going to make the schemas themselves disappear on either Transport.

Codex still has no token deltas. `runStreamed()` was measured emitting zero `item.updated` events; the whole answer arrives in one `item.completed`, same as the cli Transport's single `turn.completed`-adjacent `item.completed` line. `streaming` stays `false` for codex on both Transports — there is nothing incremental to relay, sdk or cli.

The codex SDK has no `--ephemeral` equivalent. `ThreadOptions` carries no such flag, and threads persist to `~/.codex/sessions`; measured directly, one Turn wrote one session file (84 -> 85 in that directory). This is a real regression against the cli Transport, accepted here as disk cost rather than correctness cost: ADR-0001's statelessness still holds, because a fresh thread is started per Turn and `resumeThread()` is never called — nothing is ever replayed from a prior session, only written and then ignored.

The codex SDK also resolves its own npm-vendored binary rather than searching PATH, so it can silently drift from a separately-installed `codex` — the two are not guaranteed to be the same build. And it invokes `codex exec --experimental-json`, not the `--json` the cli Transport uses; the event shapes have matched in testing, but they are two different, independently-versioned flags on the vendor's side.

Both SDKs bundle their own native binary, so the project is no longer zero-dependency. `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are now real entries in `package.json`, with a `bun.lock` and a `node_modules` `.gitignore` alongside them. `bun install` is now a required step before running the server.

## Three decisions

**The only automatic fallback is an SDK package that won't import.** A runtime error from a working SDK — a 429, a context-length overflow, a refusal — is not "the SDK is broken," and retrying it through the CLI would double the spend on exactly the Turns that were already expensive. It is also impossible mid-stream: once the first SSE chunk is flushed the response headers are already committed, and there is nowhere left to fall back to. So `resolveBackend` only falls back to cli when the vendor package failed to `import()` at startup — a `try { await import(...) } catch { null }` around each SDK, checked once, never at request time. A Model that needs the cli Transport for some other reason pins itself with `"transport": "cli"` in `models.json` instead of relying on any runtime fallback.

**Untranslatable `args` are a boot failure, not a silent drop.** `models.json` carries raw CLI flags; the sdk Transport has no argv to append them to. Known flags translate to typed SDK options — `--setting-sources ""` becomes `settingSources: []`, `--allowed-tools ""` becomes `allowedTools: []`, `--mcp-config '{"mcpServers":{}}'` becomes `mcpServers: {}`, and codex's `-c key=value` becomes a `configOverrides` entry — and anything unrecognised throws at startup, in `validateClaudeSdkArgs` / `validateCodexSdkArgs`. Silently dropping `--allowed-tools ""` would re-enable roughly thirty tool schemas and blow ADR-0002's token budget with no error raised anywhere: a Turn that still looks like it worked, costs more, and is no longer sandboxed. A boot failure is the strictly milder outcome, and it names the fix (add a translation, or pin the Model to `"transport": "cli"`) in the thrown message.

**The Backend seam had to move.** The old interface was process-shaped: `bin`, an argv builder, a line decoder. `src/server.ts` owned the process lifecycle at four separate points — spawn, stderr drain, exit code, kill on abort. An SDK Turn has none of that, so the alternative to moving the seam was branching `if (sdk)` at each of those four points in `server.ts`. `src/backends/index.ts`'s own file header already forbids this in spirit ("nothing outside a Backend file may know a specific CLI binary or its flags exist"); a Backend now owns its full execution via `run(req, signal) -> TurnRun`, and the process-specific parts of that contract (`kill`, stderr, exit code) live only in `src/backends/cli.ts`, not in `server.ts`.

## ADR-0002, partially superseded

ADR-0002 concluded "minimum overhead and subscription auth are mutually exclusive," because `--bare` reads `ANTHROPIC_API_KEY` only and returned "Not logged in" against a subscription login. The sdk Transport's isolation mode is a third option ADR-0002 didn't have available: it keeps OAuth login working *and* trims overhead, landing between `--bare` and the targeted strip. That doesn't make ADR-0002 wrong for the record it's a record of — the targeted strip is still what the cli Transport uses and still the only option when the sdk Transport isn't importable. ADR-0002 itself is left unedited; this note is the update.

## Policy caveat

Anthropic's Agent SDK docs (`https://code.claude.com/docs/en/agent-sdk/overview` and `.../quickstart`) both carry this verbatim: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

Read narrowly, that targets *offering* claude.ai login to others in a distributed product; this server is local-only, binds to `127.0.0.1`, and doesn't redistribute anyone's login. But no doc language affirmatively permits subscription-billed SDK use either — the quickstart's own recommended path is an API key. So: technically functional, not documented as supported, and not something to rely on for anything distributed to a third party. Codex carries no equivalent restriction; ChatGPT plan sign-in is its own docs' recommended auth path.
