# Run the localAIWrapper server. Run `make` (or `make help`) to list targets.
# No config is hardcoded: HOST, PORT, TOOL_EMULATION, WORKDIR_ROOTS, ... pass
# through from the environment (`make prod TOOL_EMULATION=1` works) and from
# .env, which Bun loads itself.
#
# Background state lives in .run/ (gitignored): server.pid, server.log.
# The background server runs in its own session/process group (macOS has no
# setsid(1), so perl does it), and `make stop` signals the whole group so any
# spawned CLI children go with it.

.DEFAULT_GOAL := help
.PHONY: help dev prod dev-bg prod-bg stop status logs test typecheck

# Shared shell helpers, loaded into each recipe with: eval "$$LIB"
define LIB
RUN_DIR=.run
PID_FILE=.run/server.pid
LOG_FILE=.run/server.log
resolve_port() {
  p="$${PORT:-}"
  if [ -z "$$p" ] && [ -f .env ]; then
    p=$$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 \
      | sed -E "s/^[\"']//; s/[\"'][[:space:]]*(#.*)?$$//; s/[[:space:]]+#.*$$//; s/[[:space:]]+$$//")
  fi
  case "$$p" in ""|*[!0-9]*) p=8080 ;; esac
  echo "$$p"
}
port_pids() { lsof -nP -iTCP:"$$1" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' '; }
# Is the pid file's pid alive AND still our server (guards against PID reuse)?
pid_is_ours() {
  [ -n "$$1" ] && kill -0 "$$1" 2>/dev/null || return 1
  # We started it as a session leader (pgid == pid) running bun.
  set -- "$$1" "$$(ps -o pgid=,command= -p "$$1" 2>/dev/null)"
  [ "$$(echo "$$2" | awk '{print $$1}')" = "$$1" ] && echo "$$2" | grep -q 'bun'
}
read_pid() { [ -f "$$PID_FILE" ] && tr -d '[:space:]' < "$$PID_FILE" || true; }
# Exit 1 with a message if a server is already running or the port is taken.
# Also removes a stale pid file.
ensure_free() {
  pid=$$(read_pid)
  if [ -n "$$pid" ]; then
    if pid_is_ours "$$pid"; then
      echo "Server already running in the background (pid $$pid). Run 'make stop' first." >&2; exit 1
    fi
    echo "Removing stale pid file (pid $$pid is not our server)."; rm -f "$$PID_FILE"
  fi
  port=$$(resolve_port); used=$$(port_pids "$$port")
  if [ -n "$$used" ]; then
    echo "Port $$port is already in use (pid $$used). Stop that process, or run 'make stop' if it is this server, or choose another PORT." >&2; exit 1
  fi
}
start_bg() {
  ensure_free
  mkdir -p "$$RUN_DIR"; : > "$$LOG_FILE"
  port=$$(resolve_port)
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$$@" >> "$$LOG_FILE" 2>&1 < /dev/null &
  pid=$$!
  echo "$$pid" > "$$PID_FILE"
  i=0
  while [ $$i -lt 100 ]; do
    if ! kill -0 "$$pid" 2>/dev/null; then
      rm -f "$$PID_FILE"; echo "Server exited during startup. Log:" >&2; tail -n 20 "$$LOG_FILE" >&2; exit 1
    fi
    if [ -n "$$(port_pids "$$port")" ]; then
      echo "Server started in the background (pid $$pid, port $$port). Logs: make logs   Stop: make stop"; exit 0
    fi
    sleep 0.1; i=$$((i+1))
  done
  echo "Server (pid $$pid) has not opened port $$port after 10s; check 'make logs'." >&2; exit 1
}
endef
export LIB

help:
	@echo "localAIWrapper server. Env vars (PORT, HOST, TOOL_EMULATION=1, ...) pass through: make prod PORT=9000"
	@echo
	@echo "  make dev        Foreground, auto-reload on file change (bun --watch). Ctrl-C stops it."
	@echo "  make prod       Foreground, plain 'bun run start'. Ctrl-C stops it."
	@echo "  make dev-bg     Same as dev, in the background (logs to .run/server.log)."
	@echo "  make prod-bg    Same as prod, in the background (logs to .run/server.log)."
	@echo "  make stop       Stop the background server (SIGTERM to its process group, SIGKILL after 10s)."
	@echo "  make status     Show whether the background server is running, its pid and port."
	@echo "  make logs       Follow .run/server.log (Ctrl-C to quit)."
	@echo "  make test       Unit tests (bun test test/). Does not run ./test.sh (paid CLI calls)."
	@echo "  make typecheck  tsc --noEmit."

dev:
	@eval "$$LIB"; ensure_free; exec bun --watch src/server.ts

prod:
	@eval "$$LIB"; ensure_free; exec bun run start

dev-bg:
	@eval "$$LIB"; start_bg bun --watch src/server.ts

prod-bg:
	@eval "$$LIB"; start_bg bun run start

stop:
	@eval "$$LIB"; \
	pid=$$(read_pid); \
	if [ -z "$$pid" ]; then echo "No background server running (no pid file)."; exit 0; fi; \
	if ! pid_is_ours "$$pid"; then echo "Pid file is stale (pid $$pid is not our server); removing it."; rm -f "$$PID_FILE"; exit 0; fi; \
	echo "Stopping server (process group $$pid)..."; \
	kill -TERM -- -"$$pid" 2>/dev/null || kill -TERM "$$pid" 2>/dev/null; \
	i=0; while [ $$i -lt 100 ] && kill -0 -- -"$$pid" 2>/dev/null; do sleep 0.1; i=$$((i+1)); done; \
	if kill -0 -- -"$$pid" 2>/dev/null; then echo "Still running after 10s; sending SIGKILL."; kill -KILL -- -"$$pid" 2>/dev/null; sleep 0.2; fi; \
	rm -f "$$PID_FILE"; echo "Stopped."

status:
	@eval "$$LIB"; \
	port=$$(resolve_port); pid=$$(read_pid); \
	if [ -n "$$pid" ] && pid_is_ours "$$pid"; then \
	  echo "running: pid $$pid, port $$port, http://127.0.0.1:$$port/health"; \
	  curl -fsS -m 2 "http://127.0.0.1:$$port/health" >/dev/null 2>&1 && echo "health: ok" || echo "health: no response"; \
	else \
	  [ -n "$$pid" ] && { echo "Removing stale pid file."; rm -f "$$PID_FILE"; }; \
	  echo "stopped (no background server; configured port $$port)."; \
	  used=$$(port_pids "$$port"); [ -n "$$used" ] && echo "note: port $$port is in use by another process (pid $$used)."; \
	  true; \
	fi

logs:
	@if [ -f .run/server.log ]; then exec tail -n 50 -f .run/server.log; else echo "No .run/server.log yet; start the server with make dev-bg or make prod-bg."; fi

test:
	bun test test/

typecheck:
	bunx --package typescript tsc --noEmit
