# localAIWrapper

An OpenAI-compatible HTTP server that fronts local coding-agent CLIs so they look like plain chat models to any OpenAI-compatible client.

## Language

**Backend**:
Which coding agent services a Turn — `claude` or `codex`. A Backend is reached through one of two Transports; the choice of Transport is a separate axis, not part of what "Backend" names.
_Avoid_: Provider, driver, engine

**Model**:
A named config entry that a client asks for by name in the OpenAI `model` field. A Model names a Backend plus its invocation settings. This is the only sense of "model" the HTTP surface knows; the underlying LLM is a setting inside a Model, not a Model.
_Avoid_: Engine, agent

**Transport**:
How a Backend is reached: `sdk`, the vendor's own library, or `cli`, spawning the agent's binary directly and parsing its output. Preference is sdk, then cli, decided once per Model; a Model may pin itself to one Transport.
_Avoid_: Adapter, mode, driver

**Turn**:
One chat-completions request, serviced by exactly one fresh invocation of a Backend. Turns share no state, whichever Transport carries them.
_Avoid_: Session, request, conversation
