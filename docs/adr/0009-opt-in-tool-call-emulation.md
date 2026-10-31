# Opt-in tool-call emulation

The wrapper used to reject `tools`, `functions` and `tool_choice` with a 400, because the CLIs behind a Backend cannot return a structured tool call and silently dropping the fields would leave a client waiting for `tool_calls` that never arrive. That rule stays the default.

Clients that run an agent loop (DeepTutor's Mastery Path is the case that prompted this) retry without tools after the 400. The model then writes tool-call markup as plain text and the loop stalls. So `TOOL_EMULATION=1` turns on an emulation layer in `src/toolEmulation.ts`:

- The tool schemas go into the Turn's system prompt, with an instruction to reply with `<tool_call>{"name":...,"arguments":{...}}</tool_call>` blocks.
- The reply is read whole and parsed. Blocks that parse and name an offered tool become OpenAI `tool_calls` with `finish_reason: "tool_calls"`. Text after the first block is dropped, since it can only be an invented result.
- Assistant `tool_calls` and `role: "tool"` messages in the history are flattened to `<tool_call>` / `<tool_result>` text, so Backends and `flattenMessages` stay unaware of tools. This also applies to a Turn that carries tool history but no `tools`.
- The wrapper still runs no tool. The client owns the loop; this does not make the wrapper an agent harness.

**Against**: it is prompt-based, so a model can emit a malformed block (it is then treated as prose) or call a tool when it should not. A streaming client gets no incremental tokens on an emulated Turn, because the whole reply must be read first; it is re-framed as SSE afterwards. Each Turn also carries the schemas as extra prompt tokens (see ADR 0002 for the existing overhead).

**For**: it is off by default, so existing behaviour and its 400 tests are unchanged, and it needs no change to any Backend.
