# localAIWrapper

An OpenAI-compatible HTTP server that fronts local coding-agent CLIs so they look like plain chat models to any OpenAI-compatible client.

## Language

**Backend**:
The adapter that drives one CLI binary: how to build its argv and how to decode its output stream.
_Avoid_: Provider, driver, engine

**Model**:
A named config entry that a client asks for by name in the OpenAI `model` field. A Model names a Backend plus its invocation settings. This is the only sense of "model" the HTTP surface knows; the underlying LLM is a setting inside a Model, not a Model.
_Avoid_: Engine, agent

**Turn**:
One chat-completions request, serviced by exactly one freshly spawned CLI process. Turns share no state.
_Avoid_: Session, request, conversation
