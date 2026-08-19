# Stateless replay over CLI session resume

Both `claude` and `codex` offer session persistence and resumption, and we deliberately don't use it: every Turn spawns a fresh CLI process and replays the client's entire message array as the prompt.

**Against**: we re-send the whole conversation on every Turn and pay the token cost for it, rather than paying only for the new message.

**For**: replaying full history is what both the OpenAI and Ollama chat-completions protocols actually specify — the client already sends the full `messages` array every time. Ignoring CLI session resume means no session cache, no invalidation, no eviction policy, and no state machine on the server. It also makes concurrency free: two Turns never contend over a shared CLI session, because there isn't one.

The alternative — hashing the message prefix to map onto a CLI session id — would buy back latency and tokens, but at the cost of what would be the single largest source of complexity in the project. We chose simplicity and zero server-side state over that saving.
