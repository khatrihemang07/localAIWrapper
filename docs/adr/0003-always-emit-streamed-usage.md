# Always emit streamed usage, rather than gating on `stream_options.include_usage`

OpenAI's streaming convention makes `usage` opt-in: a client must set `stream_options: {include_usage: true}` to receive a trailing chunk with `choices: []` and a populated `usage`; otherwise usage is omitted entirely from a streamed response.

We emit that trailing usage chunk unconditionally, on every streamed Turn, regardless of what (if anything) the client sent in `stream_options`.

**For**: both Backends already parse real token counts off their terminal line (claude's `result`, codex's `turn.completed`) for the non-streaming path — the data is sitting right there. A client inspecting cost or context consumption is far more likely to be broken by silently-missing usage than confused by an extra chunk it didn't explicitly ask for; the ergonomic failure mode of "usage is just always there" is strictly milder than "usage is missing because you forgot an opt-in flag." Honouring `stream_options.include_usage` on top of this would add a request field to read, a branch to test, and no behaviour a client actually needs that unconditional emission doesn't already cover.

**Against**: a strict client that parses `choices` under the assumption it always has exactly one element could stumble on the empty-`choices` usage chunk if it doesn't already handle that shape from real OpenAI streams with `include_usage` enabled. This is the standard shape a spec-following client is expected to handle regardless, so we accept the (small) risk.

We may add real `stream_options.include_usage` handling later if a client needs to *suppress* the chunk, but until then, always-on is simpler and safer to have wrong.
