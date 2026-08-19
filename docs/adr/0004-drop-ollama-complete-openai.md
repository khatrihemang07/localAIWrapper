# Drop the Ollama discovery surface; complete the OpenAI one instead

Issue #3 added `GET /`, `GET /api/version`, `GET /api/tags`, and `POST /api/show` — enough of Ollama's discovery shape for an Ollama-aware client to auto-detect this server and populate its model dropdown without the user typing a base URL. `POST /api/chat` was deliberately left unimplemented: Ollama's chat wire format is newline-delimited JSON with a `done: true` terminator, not the SSE-with-`[DONE]` this server already speaks for `/v1/chat/completions`, and no client had needed it yet.

That trade-off turned out to be worse than accepted-and-dormant — it actively misleads. An Ollama-aware client probes `GET /`, sees `"Ollama is running"`, calls `/api/tags`, populates its dropdown with every Model, and only 404s the moment the user actually tries to chat:

```
GET  /api/tags  → 200, Models listed
POST /api/chat  → 404 {"error":{"message":"Not found",…}}
```

Worse, that 404 arrives in OpenAI's error envelope (`{"error":{"message","type","code"}}`), not Ollama's — a strict Ollama-native client may not even render it, leaving the user looking at a model that silently does nothing.

Closing the gap properly means adding the second streaming codec: parsing/emitting newline-delimited JSON, mapping `done`/usage field names, and maintaining that translation against a wire format we don't control and can't version alongside. Roughly 80 lines to add, forever, for a probe path this server never asked to support.

**Decision**: delete the Ollama surface entirely (`/`, `/api/version`, `/api/tags`, `/api/show`, and the response builders behind them — about 130 lines) rather than finish it. In its place, complete the surface we already committed to: OpenAI defines two model endpoints, `GET /v1/models` (list) and `GET /v1/models/{id}` (retrieve); this server only had the first. `GET /v1/models/{id}` is now implemented, and both endpoints are built from one shared helper so they cannot drift.

The bespoke `/capabilities` endpoint (also from #3) is deleted with it, not aliased. Its content — backend, underlying LLM, streaming behaviour, `tools: false`, accepted options — was invented because `/v1/models/{id}` didn't exist yet. Now that it does, that content moves into a `local_ai_wrapper` namespaced key on the standard model object instead of living at its own bespoke path. A namespaced key, not flat top-level fields, because OpenAI can add fields to the model object at any time (`tools` is a plausible future collision) and a clash would mean our value silently shadowing a real one.

**What we gave up**: zero-typing auto-discovery for Ollama-native clients. Anyone pointing such a client at this server now has to know it speaks OpenAI, not sniff it. Any OpenAI-compatible client — the large majority of local-model tooling — is unaffected; it already requires a typed base URL and model name and never touched the deleted routes.

**Why this is the right trade**: a half-implemented protocol is worse than an absent one. `GET /health` remains as the one operational, protocol-agnostic probe — it claims liveness, not capability, so it can't mislead a client into thinking chat is supported. If full Ollama support is ever wanted, it should be added as a real second codec (chat included), not revived as a discovery-only shim.
