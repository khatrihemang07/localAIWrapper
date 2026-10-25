# localAIWrapper

An OpenAI-compatible HTTP server that fronts local coding-agent CLIs so they look like plain chat models to any OpenAI-compatible client.

## Language

**Backend**:
Which coding agent services a Turn — `claude` or `codex`. A Backend is reached by spawning its CLI binary and reading its output. Its invocation (flags, environment, working directory) is the Backend's own; no caller passes a raw flag through.
_Avoid_: Provider, driver, engine, transport

**Model**:
A named config entry that a client asks for by name in the OpenAI `model` field. A Model names a Backend, the underlying LLM, and which per-request options it supports (see docs/adr/0007). This is the only sense of "model" the HTTP surface knows; the underlying LLM is a setting inside a Model, not a Model.
_Avoid_: Engine, agent

**Turn**:
One chat-completions request, serviced by exactly one fresh invocation of a Backend. Turns share no state.
_Avoid_: Session, request, conversation

**Workdir**:
The directory a Turn runs in. Set by server config (`WORKDIR_DEFAULT`) unless the request names one that resolves inside `WORKDIR_ROOTS`.
_Avoid_: cwd, project, repo

**Access**:
What a Turn may do to its Workdir. For claude: `none` (the default: no file tools), `read-only`, or `workspace-write`. For codex: `read-only` (the default: its read-only sandbox, which can still read outside the Workdir) or `workspace-write`. A Model must declare the values it accepts. For claude these are not a sandbox; see docs/adr/0007.
_Avoid_: Permission, sandbox, mode
</content>
