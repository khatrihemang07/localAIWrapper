#!/usr/bin/env bash
# Smoke test for localAIWrapper (issue #5). Starts a live server on a spare
# port, exercises every endpoint and lifecycle guarantee against it, and
# prints a clear pass/fail per check. Exits non-zero if anything failed.
# Always tears the server (and any child CLI processes) down on exit, even
# on error or Ctrl-C.
#
# This makes real `claude`/`codex` CLI calls, which cost real money. Kept to
# the minimum needed to cover every check below: short prompts, and results
# reused across checks wherever one call can prove two things at once.
# claude-fable is never called — the account has no Fable usage credits, so
# calling it errors by design; that is not a bug.

set -uo pipefail
cd "$(dirname "$0")"

find_free_port() {
  local p=$1
  for _ in $(seq 1 30); do
    if ! lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$p"
      return 0
    fi
    p=$((p + 1))
  done
  echo "$p"
}

PORT="$(find_free_port "${TEST_PORT:-8934}")"
BASE="http://127.0.0.1:${PORT}"
LOG_FILE="$(mktemp -t localaiwrapper-test-log-XXXXXX)"
WORK_DIR="$(mktemp -d -t localaiwrapper-test-XXXXXX)"

PASS=0
FAIL=0
FAILED_CHECKS=()

pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  FAILED_CHECKS+=("$1")
  printf '  \033[31mFAIL\033[0m %s -- %s\n' "$1" "${2:-}"
}
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

SERVER_PID=""
SERVER2_PID=""
# Set later by the timeout / backend-failure section; declared here because
# cleanup() runs under `set -u` and may fire before that section is reached.
ALT_DIR=""
ALT_LOG=""
kill_server() { # kill_server <pid>
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null
  for _ in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null
  return 0
}
cleanup() {
  kill_server "$SERVER_PID"
  kill_server "$SERVER2_PID"
  rm -rf "$WORK_DIR" "$LOG_FILE" "$ALT_DIR" "$ALT_LOG"
}
trap cleanup EXIT INT TERM

# ---- helpers ----------------------------------------------------------------

# jsget <file> <js expr over `d`> -- avoids a jq dependency (project is
# zero-dependency; bun is already required to run the server at all).
jsget() {
  bun -e "const d = JSON.parse(require('fs').readFileSync('$1','utf8')); console.log($2)"
}

# children -- number of live direct children of the server process, i.e.
# currently-running claude/codex CLI processes.
children() { pgrep -P "$SERVER_PID" 2>/dev/null | wc -l | tr -d ' '; }

# sse_stats <file> -- parses a saved SSE response body and prints:
#   <non-empty-content-delta-chunks> <saw-usage:0/1> <usage-total-tokens> <saw-done:0/1> <saw-finish:0/1>
sse_stats() {
  bun -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const blocks = raw.split("\n\n").map((s) => s.trim()).filter(Boolean);
    let deltaChunks = 0, sawUsage = false, usageTotal = 0, sawDone = false, sawFinish = false;
    for (const block of blocks) {
      if (!block.startsWith("data:")) continue;
      const payload = block.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.usage) { sawUsage = true; usageTotal = obj.usage.total_tokens ?? 0; }
      const choice = obj.choices && obj.choices[0];
      if (choice) {
        if (choice.delta && typeof choice.delta.content === "string" && choice.delta.content.length > 0) deltaChunks++;
        if (choice.finish_reason === "stop") sawFinish = true;
      }
    }
    console.log(deltaChunks, sawUsage ? 1 : 0, usageTotal, sawDone ? 1 : 0, sawFinish ? 1 : 0);
  ' "$1"
}

post() { # post <outfile> <json-body> -- prints http status code
  curl -s -o "$1" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "$2"
}

# ---- start the server --------------------------------------------------------

section "Starting server"
PORT="$PORT" bun run src/server.ts >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "server pid: $SERVER_PID, port: $PORT, log: $LOG_FILE"

healthy=0
for _ in $(seq 1 50); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.2
done
if [[ $healthy -ne 1 ]]; then
  echo "server never became healthy; log:"
  cat "$LOG_FILE"
  exit 1
fi
echo "server is healthy"

# ---- health, discovery, ollama probes ----------------------------------------

section "Health & discovery"

f="$WORK_DIR/health.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/health")
[[ "$code" == "200" && "$(jsget "$f" 'd.status')" == "ok" ]] && pass "GET /health" || fail "GET /health" "code=$code body=$(cat "$f")"

f="$WORK_DIR/models.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models")
count=$(jsget "$f" 'd.data.length' 2>/dev/null || echo 0)
ids=$(jsget "$f" 'd.data.map(m=>m.id).join(",")' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$count" -ge 5 && "$ids" == *"claude-sonnet"* && "$ids" == *"codex"* ]]; then
  pass "GET /v1/models lists all Models ($ids)"
else
  fail "GET /v1/models" "code=$code count=$count ids=$ids"
fi

f="$WORK_DIR/caps.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/capabilities")
allFalseTools=$(jsget "$f" 'd.data.every(m=>m.tools===false)' 2>/dev/null || echo false)
if [[ "$code" == "200" && "$allFalseTools" == "true" ]]; then
  pass "GET /capabilities reports tools:false for every Model"
else
  fail "GET /capabilities" "code=$code body=$(cat "$f")"
fi

f="$WORK_DIR/root.txt"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/")
[[ "$code" == "200" && "$(cat "$f")" == "Ollama is running" ]] && pass "GET / (Ollama root probe)" || fail "GET /" "code=$code body=$(cat "$f")"

f="$WORK_DIR/version.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/api/version")
[[ "$code" == "200" && -n "$(jsget "$f" 'd.version' 2>/dev/null)" ]] && pass "GET /api/version" || fail "GET /api/version" "code=$code body=$(cat "$f")"

f="$WORK_DIR/tags.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/api/tags")
tagCount=$(jsget "$f" 'd.models.length' 2>/dev/null || echo 0)
[[ "$code" == "200" && "$tagCount" -ge 5 ]] && pass "GET /api/tags" || fail "GET /api/tags" "code=$code count=$tagCount"

f="$WORK_DIR/show.json"
code=$(curl -s -o "$f" -w '%{http_code}' -X POST "$BASE/api/show" -H 'content-type: application/json' -d '{"model":"codex"}')
[[ "$code" == "200" && -n "$(jsget "$f" 'd.modelfile' 2>/dev/null)" ]] && pass "POST /api/show (known model)" || fail "POST /api/show" "code=$code body=$(cat "$f")"

# ---- guards (no CLI process spawned, free) -----------------------------------

section "Guards"

f="$WORK_DIR/tools.json"
code=$(post "$f" '{"model":"codex-fast","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"x"}}]}')
[[ "$code" == "400" ]] && pass '"tools" in request -> 400' || fail '"tools" -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/functions.json"
code=$(post "$f" '{"model":"codex-fast","messages":[{"role":"user","content":"hi"}],"functions":[{"name":"x"}]}')
[[ "$code" == "400" ]] && pass '"functions" in request -> 400' || fail '"functions" -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/unknown-model.json"
code=$(post "$f" '{"model":"not-a-real-model","messages":[{"role":"user","content":"hi"}]}')
msg=$(jsget "$f" 'd.error.message' 2>/dev/null || echo "")
if [[ "$code" == "404" && "$msg" == *"codex"* && "$msg" == *"claude-sonnet"* ]]; then
  pass "unknown model -> 404 listing valid names"
else
  fail "unknown model -> 404" "code=$code body=$(cat "$f")"
fi

# ---- real CLI calls -----------------------------------------------------------

section "Non-streaming chat (claude) + usage"

f="$WORK_DIR/nonstream-claude.json"
code=$(post "$f" '{"model":"claude-sonnet","messages":[{"role":"user","content":"Reply with exactly one word: pong"}]}')
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
finish=$(jsget "$f" 'd.choices[0].finish_reason' 2>/dev/null || echo "")
total=$(jsget "$f" 'd.usage.total_tokens' 2>/dev/null || echo 0)
if [[ "$code" == "200" && -n "$content" && "$finish" == "stop" ]]; then
  pass "non-streaming chat returns an answer (claude-sonnet): \"$content\""
else
  fail "non-streaming chat (claude)" "code=$code body=$(cat "$f")"
fi
if [[ "$code" == "200" && "$total" -gt 0 ]]; then
  pass "non-streaming usage is real and non-zero (claude): total_tokens=$total"
else
  fail "non-streaming usage (claude)" "total_tokens=$total"
fi

section "Streaming chat with incremental deltas (claude)"

f="$WORK_DIR/stream-claude.sse"
curl -s -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Count from one to five, one number word per line."}],"stream":true}' \
  -o "$f"
read -r deltaChunks sawUsage usageTotal sawDone sawFinish <<<"$(sse_stats "$f")"
if [[ "$deltaChunks" -gt 1 ]]; then
  pass "claude stream delivers real incremental deltas ($deltaChunks content chunks)"
else
  fail "claude incremental deltas" "deltaChunks=$deltaChunks (expected >1) -- $(cat "$f" | head -c 400)"
fi
if [[ "$sawUsage" == "1" && "$usageTotal" -gt 0 && "$sawDone" == "1" && "$sawFinish" == "1" ]]; then
  pass "streaming usage is real and non-zero (claude): total_tokens=$usageTotal"
else
  fail "streaming usage (claude)" "sawUsage=$sawUsage total=$usageTotal sawDone=$sawDone sawFinish=$sawFinish"
fi

section "Single-chunk streaming (codex) + usage"

f="$WORK_DIR/stream-codex.sse"
curl -s -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"codex-fast","messages":[{"role":"user","content":"Reply with exactly one word: pong"}],"stream":true}' \
  -o "$f"
read -r deltaChunks sawUsage usageTotal sawDone sawFinish <<<"$(sse_stats "$f")"
if [[ "$deltaChunks" == "1" && "$sawDone" == "1" && "$sawFinish" == "1" ]]; then
  pass "codex stream delivers the whole answer as a single chunk (no incremental deltas)"
else
  fail "codex single-chunk streaming" "deltaChunks=$deltaChunks sawDone=$sawDone sawFinish=$sawFinish -- $(cat "$f" | head -c 400)"
fi
if [[ "$sawUsage" == "1" && "$usageTotal" -gt 0 ]]; then
  pass "streaming usage is real and non-zero (codex): total_tokens=$usageTotal"
else
  fail "streaming usage (codex)" "sawUsage=$sawUsage total=$usageTotal"
fi

section "Multi-turn history + non-streaming usage (codex)"

f="$WORK_DIR/multiturn.json"
code=$(post "$f" '{
  "model": "codex-fast",
  "messages": [
    {"role": "user", "content": "My favorite number is 42. Just acknowledge that."},
    {"role": "assistant", "content": "Got it, your favorite number is 42."},
    {"role": "user", "content": "What is my favorite number? Reply with just the digits, nothing else."}
  ]
}')
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
total=$(jsget "$f" 'd.usage.total_tokens' 2>/dev/null || echo 0)
if [[ "$code" == "200" && "$content" == *"42"* ]]; then
  pass "multi-turn history is honoured (codex-fast): \"$content\""
else
  fail "multi-turn history (codex)" "code=$code body=$(cat "$f")"
fi
if [[ "$code" == "200" && "$total" -gt 0 ]]; then
  pass "non-streaming usage is real and non-zero (codex): total_tokens=$total"
else
  fail "non-streaming usage (codex)" "total_tokens=$total"
fi

section "Mid-stream disconnect kills the child process"

f="$WORK_DIR/disconnect.sse"
curl -s -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Write a detailed 400-word essay about the history of coffee, one sentence per line."}],"stream":true}' \
  -o "$f" &
CURL_PID=$!

sleep 2.5
mid_children=$(children)
kill "$CURL_PID" 2>/dev/null
wait "$CURL_PID" 2>/dev/null

if [[ "$mid_children" -ge 1 ]]; then
  pass "child process observed running mid-stream before disconnect (children=$mid_children)"
else
  fail "mid-stream child observed running" "children=$mid_children (response may have completed before we disconnected -- prompt may need to be longer)"
fi

if grep -q '\[DONE\]' "$f" 2>/dev/null; then
  fail "disconnect happened mid-stream" "response already completed (contains [DONE]) before disconnect -- test inconclusive, lengthen the prompt"
else
  pass "disconnect happened mid-stream (response was not yet complete)"
fi

orphan_gone=0
for _ in $(seq 1 25); do
  if [[ "$(children)" == "0" ]]; then
    orphan_gone=1
    break
  fi
  sleep 0.2
done
if [[ $orphan_gone -eq 1 ]]; then
  pass "no orphan process remains after mid-stream client disconnect"
else
  fail "no orphan process after disconnect" "still running: $(pgrep -P "$SERVER_PID" -a 2>/dev/null)"
fi

section "Concurrency cap holds under ~10 parallel requests"

CONC_DIR="$WORK_DIR/concurrency"
mkdir -p "$CONC_DIR"
CONC_PIDS=()
for i in $(seq 1 10); do
  (
    code=$(curl -s -o "$CONC_DIR/resp_$i.json" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" \
      -H 'content-type: application/json' \
      -d '{"model":"codex-fast","messages":[{"role":"user","content":"Reply with exactly one word: ok"}]}')
    echo "$code" >"$CONC_DIR/code_$i"
  ) &
  CONC_PIDS+=($!)
done

max_children=0
running=1
while [[ $running -eq 1 ]]; do
  running=0
  for pid in "${CONC_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      running=1
    fi
  done
  c=$(children)
  if ((c > max_children)); then
    max_children=$c
  fi
  sleep 0.1
done
for pid in "${CONC_PIDS[@]}"; do
  wait "$pid" 2>/dev/null
done

all_ok=1
for i in $(seq 1 10); do
  code=$(cat "$CONC_DIR/code_$i" 2>/dev/null || echo "")
  if [[ "$code" != "200" ]]; then
    all_ok=0
    echo "    request $i: code=$code"
  fi
done

if ((max_children <= 4)); then
  pass "at most 4 CLI processes ran concurrently (observed max: $max_children)"
else
  fail "concurrency cap" "observed max concurrent children: $max_children (expected <= 4)"
fi
if [[ $all_ok -eq 1 ]]; then
  pass "all 10 concurrent (queued) requests eventually succeeded"
else
  fail "all queued requests succeeded" "one or more of the 10 requests did not return 200"
fi

# ---- timeout + non-zero-exit error envelopes ----------------------------------
#
# Both need a differently-configured server: TURN_TIMEOUT_MS is read once at
# startup, and forcing a non-zero CLI exit needs a Model with deliberately bad
# args. models.json is a static import, so run a second server against a patched
# copy of the tree rather than mutating the real config.
#
# TURN_TIMEOUT_MS=1500 separates the two cases cleanly: a bogus flag makes the
# CLI exit in well under a second, while any real model call takes longer than
# 1.5s -- so neither test can be satisfied by the other's mechanism.

section "Timeout and backend-failure error envelopes"

ALT_DIR="$(mktemp -d)"
ALT_LOG="$(mktemp -t localaiwrapper-alt-log-XXXXXX)"
cp -R src package.json tsconfig.json "$ALT_DIR/" 2>/dev/null
bun -e '
  const fs = require("fs");
  const models = JSON.parse(fs.readFileSync("models.json", "utf8"));
  // A Model whose args are guaranteed to make the CLI reject its own invocation
  // and exit non-zero, without ever reaching the model (so it costs nothing).
  models["broken-on-purpose"] = {
    backend: "codex",
    model: "gpt-5.6-sol",
    systemPrompt: "You are a helpful assistant.",
    args: ["--definitely-not-a-real-flag"],
  };
  fs.writeFileSync(process.argv[1] + "/models.json", JSON.stringify(models, null, 2));
' "$ALT_DIR"

ALT_PORT="$(find_free_port 8951)"
ALT_BASE="http://127.0.0.1:$ALT_PORT"
# Started WITHOUT a subshell so SERVER2_PID is bun itself: the orphan check
# below counts the server's direct children, and a wrapping subshell would
# make bun look like the child. models.json is a static import resolved
# relative to the source file, so running by absolute path picks up the
# patched copy without needing to cd.
PORT="$ALT_PORT" TURN_TIMEOUT_MS=1500 bun run "$ALT_DIR/src/server.ts" >"$ALT_LOG" 2>&1 &
SERVER2_PID=$!

alt_healthy=0
for _ in $(seq 1 50); do
  if curl -fsS "$ALT_BASE/health" >/dev/null 2>&1; then alt_healthy=1; break; fi
  sleep 0.2
done

if [[ $alt_healthy -ne 1 ]]; then
  fail "second server started" "server on $ALT_PORT never became healthy; log: $(tail -5 "$ALT_LOG")"
else
  # A non-zero CLI exit must surface as an OpenAI error envelope, not a 200.
  broken_body="$WORK_DIR/broken.json"
  broken_code="$(curl -s -o "$broken_body" -w '%{http_code}' -X POST "$ALT_BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"model":"broken-on-purpose","messages":[{"role":"user","content":"hi"}]}')"
  broken_msg="$(jsget "$broken_body" 'd.error && d.error.message || ""' 2>/dev/null || echo "")"
  if [[ "$broken_code" != "200" && -n "$broken_msg" ]]; then
    pass "non-zero CLI exit -> error envelope (HTTP $broken_code, message carried)"
  else
    fail "non-zero exit error envelope" "got HTTP $broken_code, body: $(head -c 300 "$broken_body")"
  fi

  # A Turn exceeding TURN_TIMEOUT_MS must be killed and return an error.
  timeout_body="$WORK_DIR/timeout.json"
  timeout_code="$(curl -s -o "$timeout_body" -w '%{http_code}' -X POST "$ALT_BASE/v1/chat/completions" \
    -H 'content-type: application/json' \
    -d '{"model":"claude-sonnet","messages":[{"role":"user","content":"Write one short sentence."}]}')"
  timeout_msg="$(jsget "$timeout_body" 'd.error && d.error.message || ""' 2>/dev/null || echo "")"
  if [[ "$timeout_code" != "200" && -n "$timeout_msg" ]]; then
    pass "Turn exceeding the timeout -> error envelope (HTTP $timeout_code)"
  else
    fail "timeout error envelope" "got HTTP $timeout_code, body: $(head -c 300 "$timeout_body")"
  fi

  # The killed Turn must not leave the CLI process behind.
  sleep 1
  alt_orphans="$(pgrep -P "$SERVER2_PID" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$alt_orphans" == "0" ]]; then
    pass "no orphan process remains after a timed-out Turn"
  else
    fail "no orphan after timeout" "$alt_orphans child process(es) still running"
  fi
fi

kill_server "$SERVER2_PID"
SERVER2_PID=""

# ---- summary ------------------------------------------------------------------

section "Summary"
echo "passed: $PASS, failed: $FAIL"
if ((FAIL > 0)); then
  echo "failed checks:"
  for c in "${FAILED_CHECKS[@]}"; do
    echo "  - $c"
  done
  exit 1
fi
exit 0
