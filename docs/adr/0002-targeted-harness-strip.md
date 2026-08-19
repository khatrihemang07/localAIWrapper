# Targeted harness strip over `--bare`

`claude -p` ships a large harness by default: skills, MCP servers, plugins, `CLAUDE.md`, memory paths, and roughly 30 tool schemas, all injected into the system prompt on every invocation. Measured directly during design, on a one-word "hello":

| Configuration | System prompt tokens | Auth |
| --- | --- | --- |
| `claude -p` unmodified | 26,462 (~$0.064 for the reply) | OAuth works |
| Targeted strip (the flags we ship) | 13,795 | OAuth works |
| `--bare` | minimal | fails |

The targeted strip is `--system-prompt <configured> --strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources "" --disable-slash-commands --allowed-tools ""`.

All of it is configuration rather than code, but it reaches the CLI by two routes. The four stripping flags sit verbatim in each Model's `args` array. `--system-prompt` is the exception: its value comes from the Model's dedicated `systemPrompt` field, because a chat-completions request may carry its own `system` message that has to override the configured default per Turn — something a verbatim `args` entry cannot express. Either way, changing what is sent is a `models.json` edit, never a source change.

`--bare` was tried and rejected: it returned `"Not logged in · Please run /login"`. `--bare` reads `ANTHROPIC_API_KEY` only and never touches OAuth or the keychain, so it cannot authenticate a subscription login. Minimum overhead and subscription auth are mutually exclusive.

We chose to keep the existing subscription login working and accept ~13.8k tokens of overhead per Turn, rather than force API-key auth on every user just to shave the remaining tokens. The residual overhead is built-in tool *definitions* — `--allowed-tools ""` blocks tool *use* but the schemas still ship — and we accept that too.

Flipping to `--bare` is a config edit to a Model's `args`, not a code change, for anyone who does set an API key and wants the smaller footprint.
