## Agent skills

### Issue tracker

Issues live in GitHub Issues at khatrihemang07/localAIWrapper (uses the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (root `CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Running

Bun project (no pnpm/npm). Use the Makefile: `make help` lists targets. `make dev` / `make prod` run in the foreground; `make dev-bg` / `make prod-bg` run in the background with state in gitignored `.run/` (pid file and log); `make stop`, `make status`, `make logs`; `make test` (unit tests only; `./test.sh` makes paid CLI calls) and `make typecheck`. Config (`PORT`, `HOST`, `TOOL_EMULATION`, ...) comes from the environment or `.env`, e.g. `make prod TOOL_EMULATION=1`.
