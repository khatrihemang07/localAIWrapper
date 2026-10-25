#!/usr/bin/env bash
# Smoke test for localAIWrapper (issue #5). Starts a live server on a spare
# port, exercises every endpoint and lifecycle guarantee against it, and
# prints a clear pass/fail per check. Exits non-zero if anything failed.
# Always tears the server (and any child CLI processes) down on exit, even
# on error or Ctrl-C.
#
# This makes real `claude`/`codex` CLI calls, which cost real money. Kept to
# the minimum needed to cover every check below: short prompts, haiku and
# luna wherever the check does not need a larger Model, and results reused
# across checks wherever one call can prove two things at once.

set -uo pipefail
cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

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

# The directories every workdir / access check runs against. The server's
# configured default and its allowlist both live under WORK_DIR, so nothing
# the tests write touches the repository.
DEFAULT_DIR="$WORK_DIR/default"
ALLOWED_DIR="$WORK_DIR/allowed"
SUB_DIR="$ALLOWED_DIR/sub"
OUTSIDE_DIR="$WORK_DIR/outside"
mkdir -p "$DEFAULT_DIR" "$SUB_DIR" "$OUTSIDE_DIR"
ln -s "$OUTSIDE_DIR" "$ALLOWED_DIR/escape-link"

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
SERVER3_PID=""
# Set later by the timeout / backend-failure section; declared here because
# cleanup() runs under `set -u` and may fire before that section is reached.
ALT_DIR=""
ALT_LOG=""
BAD_DIR=""
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
  kill_server "$SERVER3_PID"
  rm -rf "$WORK_DIR" "$LOG_FILE" "$ALT_DIR" "$ALT_LOG" "$BAD_DIR"
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

# content_matches_schema <response-file> -- prints "yes" when the assistant
# message is JSON with exactly the keys color (string) and n (integer).
# sse_tools_separated <sse-file> -- prints "yes" when the streamed answer starts
# with the text written before the tool call, a blank line, then the answer
# after the tool call: "Let me read the file.\n\n...PLUM". No leading separator.
sse_tools_separated() {
  bun -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    let content = "";
    for (const block of raw.split("\n\n")) {
      const t = block.trim();
      if (!t.startsWith("data:") || t.slice(5).trim() === "[DONE]") continue;
      for (const c of JSON.parse(t.slice(5)).choices || []) {
        if (c.delta && typeof c.delta.content === "string") content += c.delta.content;
      }
    }
    const ok = /^Let me read the file\.\n\n[\s\S]*PLUM/.test(content);
    console.log(ok ? "yes" : "no " + JSON.stringify(content.slice(0, 200)));
  ' "$1"
}

content_matches_schema() {
  bun -e '
    const fs = require("fs");
    const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    try {
      const o = JSON.parse(d.choices[0].message.content);
      const keys = Object.keys(o).sort().join(",");
      console.log(keys === "color,n" && typeof o.color === "string" && Number.isInteger(o.n) ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$1"
}

# sse_content_matches_schema <sse-file> -- like content_matches_schema, but for a
# streamed body: concatenates the content deltas first, then checks the same keys.
sse_content_matches_schema() {
  bun -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    let content = "";
    for (const block of raw.split("\n\n")) {
      const t = block.trim();
      if (!t.startsWith("data:") || t.slice(5).trim() === "[DONE]") continue;
      const obj = JSON.parse(t.slice(5));
      for (const c of obj.choices || []) {
        if (c.delta && typeof c.delta.content === "string") content += c.delta.content;
      }
    }
    try {
      const o = JSON.parse(content);
      const keys = Object.keys(o).sort().join(",");
      console.log(keys === "color,n" && typeof o.color === "string" && Number.isInteger(o.n) ? "yes" : "no");
    } catch { console.log("no"); }
  ' "$1"
}

post() { # post <outfile> <json-body> -- prints http status code
  curl -s -o "$1" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' -d "$2"
}

SCHEMA='{"name":"pair","schema":{"type":"object","properties":{"color":{"type":"string"},"n":{"type":"integer"}},"required":["color","n"],"additionalProperties":false}}'

# ---- start the server --------------------------------------------------------

section "Starting server"
# The server is given bogus API keys on purpose. If they reached a child CLI
# they would override the subscription login and the real calls below would
# fail; passing means the child environment is scrubbed (src/backends/cli.ts).
WORKDIR_DEFAULT="$DEFAULT_DIR" WORKDIR_ROOTS="$ALLOWED_DIR" \
  ANTHROPIC_API_KEY="sk-ant-bogus-for-scrub-test" OPENAI_API_KEY="sk-bogus-for-scrub-test" \
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

# ---- health & OpenAI discovery -------------------------------------------

section "Health & discovery"

f="$WORK_DIR/health.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/health")
[[ "$code" == "200" && "$(jsget "$f" 'd.status')" == "ok" ]] && pass "GET /health" || fail "GET /health" "code=$code body=$(cat "$f")"

# Expected count/names come from models.json itself, not a hardcoded number,
# so this check can't rot the next time a Model is added or removed.
expected_count=$(jsget "models.json" 'Object.keys(d).length')
expected_ids=$(jsget "models.json" 'Object.keys(d).sort().join(",")')

f="$WORK_DIR/models-list.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models")
count=$(jsget "$f" 'd.data.length' 2>/dev/null || echo 0)
ids=$(jsget "$f" 'd.data.map(m=>m.id).sort().join(",")' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$count" == "$expected_count" && "$ids" == "$expected_ids" ]]; then
  pass "GET /v1/models lists exactly the Models in models.json ($ids)"
else
  fail "GET /v1/models" "code=$code count=$count (expected $expected_count) ids=$ids (expected $expected_ids)"
fi

allLocalAiWrapper=$(jsget "$f" 'd.data.every(m=>m.local_ai_wrapper && typeof m.local_ai_wrapper.streaming==="boolean" && m.local_ai_wrapper.tools===false)' 2>/dev/null || echo false)
noLeakedInternals=$(jsget "$f" '!JSON.stringify(d).match(/"(args|bin|transport)"/)' 2>/dev/null || echo false)
if [[ "$allLocalAiWrapper" == "true" && "$noLeakedInternals" == "true" ]]; then
  pass "GET /v1/models carries local_ai_wrapper block and never leaks args/bin/transport"
else
  fail "GET /v1/models local_ai_wrapper shape" "allLocalAiWrapper=$allLocalAiWrapper noLeakedInternals=$noLeakedInternals"
fi

# Every Model advertises all four options, each with supported/values/default/description.
allOptions=$(jsget "$f" 'd.data.every(m=>["reasoning_effort","web","access","workdir"].every(k=>{const o=m.local_ai_wrapper.options[k]; return o && typeof o.supported==="boolean" && "values" in o && "default" in o && typeof o.description==="string";}))' 2>/dev/null || echo false)
if [[ "$allOptions" == "true" ]]; then
  pass "every Model advertises reasoning_effort, web, access and workdir under local_ai_wrapper.options"
else
  fail "options advertisement" "allOptions=$allOptions"
fi

f="$WORK_DIR/models-retrieve-haiku.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models/claude-haiku")
webSupported=$(jsget "$f" 'd.local_ai_wrapper.options.web.supported' 2>/dev/null || echo "")
webDefault=$(jsget "$f" 'd.local_ai_wrapper.options.web.default' 2>/dev/null || echo "")
accessDefault=$(jsget "$f" 'd.local_ai_wrapper.options.access.default' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$webSupported" == "true" && "$webDefault" == "false" && "$accessDefault" == "none" ]]; then
  pass "GET /v1/models/claude-haiku advertises web (supported, default off) and access (default none)"
else
  fail "GET /v1/models/claude-haiku options" "code=$code web.supported=$webSupported web.default=$webDefault access.default=$accessDefault"
fi

if grep -q "$DEFAULT_DIR" "$f"; then
  fail "discovery does not leak the configured default directory" "found $DEFAULT_DIR in response"
else
  pass "discovery does not leak the configured default directory"
fi

f="$WORK_DIR/models-retrieve-sonnet.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models/claude-sonnet")
streaming=$(jsget "$f" 'd.local_ai_wrapper.streaming' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$streaming" == "true" ]]; then
  pass "GET /v1/models/claude-sonnet reports streaming:true"
else
  fail "GET /v1/models/claude-sonnet" "code=$code body=$(cat "$f")"
fi

f="$WORK_DIR/models-retrieve-codex-sol.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models/codex-sol")
streaming=$(jsget "$f" 'd.local_ai_wrapper.streaming' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$streaming" == "false" ]]; then
  pass "GET /v1/models/codex-sol reports streaming:false"
else
  fail "GET /v1/models/codex-sol" "code=$code body=$(cat "$f")"
fi

listSonnet=$(jsget "$WORK_DIR/models-list.json" 'JSON.stringify(d.data.find(m=>m.id==="claude-sonnet"))' 2>/dev/null || echo "")
retrieveSonnet=$(jsget "$WORK_DIR/models-retrieve-sonnet.json" 'JSON.stringify(d)' 2>/dev/null || echo "")
if [[ -n "$listSonnet" && "$listSonnet" == "$retrieveSonnet" ]]; then
  pass "GET /v1/models/claude-sonnet is byte-identical to its list entry"
else
  fail "list/retrieve identity" "list=$listSonnet retrieve=$retrieveSonnet"
fi

f="$WORK_DIR/models-retrieve-unknown.json"
code=$(curl -s -o "$f" -w '%{http_code}' "$BASE/v1/models/nope")
msg=$(jsget "$f" 'd.error.message' 2>/dev/null || echo "")
if [[ "$code" == "404" && "$msg" == *"codex"* && "$msg" == *"claude-sonnet"* ]]; then
  pass "GET /v1/models/nope -> 404 listing valid names"
else
  fail "GET /v1/models/nope -> 404" "code=$code body=$(cat "$f")"
fi

for path in "/" "/api/version" "/api/tags" "/capabilities"; do
  f="$WORK_DIR/gone$(echo "$path" | tr '/' '_').json"
  code=$(curl -s -o "$f" -w '%{http_code}' "$BASE$path")
  [[ "$code" == "404" ]] && pass "GET $path -> 404 (Ollama/capabilities surface removed)" || fail "GET $path -> 404" "code=$code body=$(cat "$f")"
done

f="$WORK_DIR/gone_show.json"
code=$(curl -s -o "$f" -w '%{http_code}' -X POST "$BASE/api/show" -H 'content-type: application/json' -d '{"model":"codex-sol"}')
[[ "$code" == "404" ]] && pass "POST /api/show -> 404 (Ollama surface removed)" || fail "POST /api/show -> 404" "code=$code body=$(cat "$f")"

# ---- guards (no CLI process spawned, free) -----------------------------------

section "Guards"

f="$WORK_DIR/tools.json"
code=$(post "$f" '{"model":"codex-sol","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"x"}}]}')
[[ "$code" == "400" ]] && pass '"tools" in request -> 400' || fail '"tools" -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/functions.json"
code=$(post "$f" '{"model":"codex-sol","messages":[{"role":"user","content":"hi"}],"functions":[{"name":"x"}]}')
[[ "$code" == "400" ]] && pass '"functions" in request -> 400' || fail '"functions" -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/tool_choice.json"
code=$(post "$f" '{"model":"codex-sol","messages":[{"role":"user","content":"hi"}],"tool_choice":"auto"}')
[[ "$code" == "400" ]] && pass '"tool_choice" in request -> 400' || fail '"tool_choice" -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/unknown-model.json"
code=$(post "$f" '{"model":"not-a-real-model","messages":[{"role":"user","content":"hi"}]}')
msg=$(jsget "$f" 'd.error.message' 2>/dev/null || echo "")
if [[ "$code" == "404" && "$msg" == *"codex"* && "$msg" == *"claude-sonnet"* ]]; then
  pass "unknown model -> 404 listing valid names"
else
  fail "unknown model -> 404" "code=$code body=$(cat "$f")"
fi

f="$WORK_DIR/system-only.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"system","content":"You are terse."}]}')
[[ "$code" == "400" ]] && pass "system-only messages -> 400 (nothing to answer, no CLI spawned)" || fail "system-only messages -> 400" "code=$code body=$(cat "$f")"

f="$WORK_DIR/effort-bad.json"
code=$(post "$f" '{"model":"codex-sol","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"max"}')
[[ "$code" == "400" ]] && pass 'reasoning_effort "max" on codex-sol (not declared) -> 400' || fail 'reasoning_effort per-Model value check' "code=$code body=$(cat "$f")"

f="$WORK_DIR/access-bad.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"access":"danger-full-access"}')
[[ "$code" == "400" ]] && pass 'access "danger-full-access" -> 400' || fail 'access value check' "code=$code body=$(cat "$f")"

f="$WORK_DIR/access-none-codex.json"
code=$(post "$f" '{"model":"codex-luna","messages":[{"role":"user","content":"hi"}],"access":"none"}')
[[ "$code" == "400" ]] && pass 'access "none" on codex-luna (codex has no none) -> 400' || fail 'codex access none -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/rf-json-object.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}')
[[ "$code" == "400" ]] && pass 'response_format type "json_object" -> 400 (only text and json_schema are accepted)' || fail 'response_format json_object -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/rf-malformed.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_schema","json_schema":{"schema":{"type":"object"}}}}')
[[ "$code" == "400" ]] && pass 'response_format json_schema without a name -> 400' || fail 'malformed json_schema -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/wd-relative.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"hi"}],"workdir":"sub"}')
[[ "$code" == "400" ]] && pass 'relative workdir -> 400' || fail 'relative workdir -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/wd-missing.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"workdir\":\"$ALLOWED_DIR/does-not-exist\"}")
[[ "$code" == "400" ]] && pass 'workdir that does not exist -> 400' || fail 'missing workdir -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/wd-outside.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"workdir\":\"$OUTSIDE_DIR\"}")
[[ "$code" == "400" ]] && pass 'workdir outside WORKDIR_ROOTS -> 400' || fail 'outside workdir -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/wd-dotdot.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"workdir\":\"$SUB_DIR/../../outside\"}")
[[ "$code" == "400" ]] && pass 'workdir ".." escape out of the allowlist -> 400' || fail 'workdir .. escape -> 400' "code=$code body=$(cat "$f")"

f="$WORK_DIR/wd-symlink.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"workdir\":\"$ALLOWED_DIR/escape-link\"}")
[[ "$code" == "400" ]] && pass 'workdir symlink escaping the allowlist -> 400' || fail 'workdir symlink escape -> 400' "code=$code body=$(cat "$f")"

if [[ "$(jsget "$WORK_DIR/wd-missing.json" 'd.error.message')" == "$(jsget "$WORK_DIR/wd-outside.json" 'd.error.message')" ]]; then
  pass "a nonexistent workdir and one outside the roots get the same message (no existence probe)"
else
  fail "workdir messages identical" "missing=$(jsget "$WORK_DIR/wd-missing.json" 'd.error.message') outside=$(jsget "$WORK_DIR/wd-outside.json" 'd.error.message')"
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
  pass "server env ANTHROPIC_API_KEY (bogus) did not reach claude: the plan login answered"
else
  fail "non-streaming chat (claude)" "code=$code body=$(cat "$f")"
  fail "server env ANTHROPIC_API_KEY (bogus) did not reach claude" "claude call failed"
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
  -d '{"model":"codex-luna","messages":[{"role":"user","content":"Reply with exactly one word: pong"}],"stream":true}' \
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
  "model": "codex-luna",
  "messages": [
    {"role": "user", "content": "My favorite number is 42. Just acknowledge that."},
    {"role": "assistant", "content": "Got it, your favorite number is 42."},
    {"role": "user", "content": "What is my favorite number? Reply with just the digits, nothing else."}
  ]
}')
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
total=$(jsget "$f" 'd.usage.total_tokens' 2>/dev/null || echo 0)
if [[ "$code" == "200" && "$content" == *"42"* ]]; then
  pass "multi-turn history is honoured (codex-luna): \"$content\""
else
  fail "multi-turn history (codex)" "code=$code body=$(cat "$f")"
fi
if [[ "$code" == "200" && "$total" -gt 0 ]]; then
  pass "non-streaming usage is real and non-zero (codex): total_tokens=$total"
else
  fail "non-streaming usage (codex)" "total_tokens=$total"
fi

section "Web: off by default, on when asked, and the Model must support it"

f="$WORK_DIR/web-on-claude.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"web":true}')
if [[ "$code" == "200" ]]; then
  pass "web:true on claude-haiku (supported) -> 200"
else
  fail "web:true on claude-haiku" "code=$code body=$(cat "$f")"
fi

f="$WORK_DIR/web-on-codex.json"
code=$(post "$f" '{"model":"codex-luna","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"web":true}')
if [[ "$code" == "200" ]]; then
  pass "web:true on codex-luna (supported, web_search=live accepted by codex) -> 200"
else
  fail "web:true on codex-luna" "code=$code body=$(cat "$f")"
fi
# Default-off is asserted by the unit tests (test/claudeTools.test.ts): the
# tool set the Backend builds for a request without `web` excludes WebSearch
# and WebFetch. Over HTTP there is no way to read the tool list back.

section "Access and workdir: what each access level allows"

# claude: the configured default is used when no workdir is given.
f="$WORK_DIR/claude-default-write.json"
code=$(post "$f" '{"model":"claude-haiku","access":"workspace-write","messages":[{"role":"user","content":"Create a file named default-marker.txt in the current directory containing the word hi. Then reply done."}]}')
if [[ "$code" == "200" && -f "$DEFAULT_DIR/default-marker.txt" && ! -e "$REPO_DIR/default-marker.txt" ]]; then
  pass "claude workspace-write with no workdir writes into WORKDIR_DEFAULT, not the server cwd"
else
  fail "claude default cwd" "code=$code default-file=$(ls "$DEFAULT_DIR" 2>/dev/null | tr '\n' ' ') repo-file=$([[ -e "$REPO_DIR/default-marker.txt" ]] && echo yes || echo no)"
fi

f="$WORK_DIR/claude-sub-write.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"access\":\"workspace-write\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named claude-marker.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && -f "$SUB_DIR/claude-marker.txt" ]]; then
  pass "claude workspace-write with an allowlisted workdir writes into that directory"
else
  fail "claude workspace-write in workdir" "code=$code body=$(head -c 200 "$f") sub=$(ls "$SUB_DIR" | tr '\n' ' ')"
fi

# claude access none (the default): no file tools, so it cannot create a file...
f="$WORK_DIR/claude-none-write.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named claude-none.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && ! -e "$SUB_DIR/claude-none.txt" ]]; then
  pass "claude default access (none) cannot create a file"
else
  fail "claude none blocks writes" "code=$code file-exists=$([[ -e "$SUB_DIR/claude-none.txt" ]] && echo yes || echo no)"
fi

# ...and cannot read a file in its workdir either.
printf 'PINEAPPLE-7\n' >"$DEFAULT_DIR/none-secret.txt"
f="$WORK_DIR/claude-none-read.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"Read the file none-secret.txt in the current directory and reply with its exact contents."}]}')
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$content" != *"PINEAPPLE-7"* ]]; then
  pass "claude default access (none) cannot read a file in its workdir"
else
  fail "claude none blocks reads" "code=$code content=$(head -c 200 "$f")"
fi

# claude read-only: reads files in the default workdir, and cannot create one.
printf 'MANGO-3\n' >"$DEFAULT_DIR/readonly-secret.txt"
f="$WORK_DIR/claude-ro-read.json"
code=$(post "$f" '{"model":"claude-haiku","access":"read-only","messages":[{"role":"user","content":"Read the file readonly-secret.txt in the current directory and reply with its exact contents."}]}')
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$content" == *"MANGO-3"* ]]; then
  pass "claude read-only reads a file in the default workdir"
else
  fail "claude read-only read" "code=$code content=$(head -c 200 "$f")"
fi

f="$WORK_DIR/claude-ro-write.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"access\":\"read-only\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named claude-ro.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && ! -e "$SUB_DIR/claude-ro.txt" ]]; then
  pass "claude read-only cannot create a file"
else
  fail "claude read-only blocks writes" "code=$code file-exists=$([[ -e "$SUB_DIR/claude-ro.txt" ]] && echo yes || echo no)"
fi

# codex: the sandbox does the enforcing.
f="$WORK_DIR/codex-sub-write.json"
code=$(post "$f" "{\"model\":\"codex-luna\",\"access\":\"workspace-write\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named codex-marker.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && -f "$SUB_DIR/codex-marker.txt" ]]; then
  pass "codex workspace-write with an allowlisted workdir writes into that directory"
else
  fail "codex workspace-write in workdir" "code=$code body=$(head -c 200 "$f") sub=$(ls "$SUB_DIR" | tr '\n' ' ')"
fi

# codex read-only (its default) reads outside its workdir: the sandbox limits writes, not reads.
# (The file name avoids "secret": codex refuses that word as a policy matter,
# which would hide the sandbox behaviour this check is for.)
printf 'KIWI-9\n' >"$DEFAULT_DIR/codex-kiwi-note.txt"
f="$WORK_DIR/codex-ro-read-outside.json"
code=$(post "$f" "{\"model\":\"codex-luna\",\"access\":\"read-only\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Read the file $DEFAULT_DIR/codex-kiwi-note.txt and reply with its exact contents.\"}]}")
content=$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null || echo "")
if [[ "$code" == "200" && "$content" == *"KIWI-9"* ]]; then
  pass "codex read-only reads a file outside its workdir (reads are not confined; only writes are)"
else
  fail "codex read-only read outside workdir" "code=$code content=$(head -c 200 "$f")"
fi

f="$WORK_DIR/codex-ro-write.json"
code=$(post "$f" "{\"model\":\"codex-luna\",\"access\":\"read-only\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named codex-ro.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && ! -e "$SUB_DIR/codex-ro.txt" ]]; then
  pass "codex read-only cannot create a file"
else
  fail "codex read-only blocks writes" "code=$code file-exists=$([[ -e "$SUB_DIR/codex-ro.txt" ]] && echo yes || echo no)"
fi

f="$WORK_DIR/codex-none-write.json"
code=$(post "$f" "{\"model\":\"codex-luna\",\"workdir\":\"$SUB_DIR\",\"messages\":[{\"role\":\"user\",\"content\":\"Create a file named codex-none.txt in the current directory containing the word hi. Then reply done.\"}]}")
if [[ "$code" == "200" && ! -e "$SUB_DIR/codex-none.txt" ]]; then
  pass "codex default access (read-only) cannot create a file"
else
  fail "codex default blocks writes" "code=$code file-exists=$([[ -e "$SUB_DIR/codex-none.txt" ]] && echo yes || echo no)"
fi

section "Structured output (response_format json_schema)"

f="$WORK_DIR/schema-claude.json"
code=$(post "$f" "{\"model\":\"claude-haiku\",\"response_format\":{\"type\":\"json_schema\",\"json_schema\":$SCHEMA},\"messages\":[{\"role\":\"user\",\"content\":\"Give a color and a number.\"}]}")
if [[ "$code" == "200" && "$(content_matches_schema "$f")" == "yes" ]]; then
  pass "claude returns JSON matching the requested schema"
else
  fail "claude structured output" "code=$code body=$(head -c 300 "$f")"
fi

f="$WORK_DIR/schema-codex.json"
code=$(post "$f" "{\"model\":\"codex-luna\",\"response_format\":{\"type\":\"json_schema\",\"json_schema\":$SCHEMA},\"messages\":[{\"role\":\"user\",\"content\":\"Give a color and a number.\"}]}")
if [[ "$code" == "200" && "$(content_matches_schema "$f")" == "yes" ]]; then
  pass "codex returns JSON matching the requested schema"
else
  fail "codex structured output" "code=$code body=$(head -c 300 "$f")"
fi

f="$WORK_DIR/rf-text-claude.json"
code=$(post "$f" '{"model":"claude-haiku","messages":[{"role":"user","content":"Reply with exactly one word: ok"}],"response_format":{"type":"text"}}')
if [[ "$code" == "200" && "$(jsget "$f" 'd.choices[0].message.content' 2>/dev/null)" != "" ]]; then
  pass 'response_format {"type":"text"} is accepted as a no-op (claude-haiku) -> 200'
else
  fail 'response_format text no-op' "code=$code body=$(head -c 300 "$f")"
fi

f="$WORK_DIR/stream-schema-claude.sse"
curl -s -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d "{\"model\":\"claude-haiku\",\"stream\":true,\"response_format\":{\"type\":\"json_schema\",\"json_schema\":$SCHEMA},\"messages\":[{\"role\":\"user\",\"content\":\"Give a color and a number.\"}]}" \
  -o "$f"
if [[ "$(sse_content_matches_schema "$f")" == "yes" ]]; then
  pass "claude stream with json_schema delivers schema-conforming JSON as content"
else
  fail "claude stream structured output" "body=$(head -c 300 "$f")"
fi

section "Tool use: text from a later message is separated (claude)"

printf 'The secret word is PLUM.\n' >"$DEFAULT_DIR/stream-tools.txt"
f="$WORK_DIR/stream-tools.sse"
curl -s -N -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","access":"read-only","messages":[{"role":"user","content":"Write the sentence '"'"'Let me read the file.'"'"' as plain text in your reply first, then call the Read tool on stream-tools.txt, then tell me the word in it."}],"stream":true}' \
  -o "$f"
sep=$(sse_tools_separated "$f")
if [[ "$sep" == "yes" ]]; then
  pass "streamed answer after a tool call has no leading separator and is separated from the text before the tool"
else
  fail "tool-use stream separator" "$sep -- $(head -c 400 "$f")"
fi

section "Prompt on stdin: dash-leading system prompts and a long prompt"

# A system message starting with "-" (and a bare "--") used to be read as a
# CLI flag. The prompt now travels on stdin, so both are plain text. Both
# Backends are checked.
for m in claude-haiku codex-luna; do
  for sys in "- Always answer in lowercase." "--"; do
    f="$WORK_DIR/dash-$m-$(echo "$sys" | tr -c 'a-z' '_').json"
    code=$(post "$f" "{\"model\":\"$m\",\"messages\":[{\"role\":\"system\",\"content\":\"$sys\"},{\"role\":\"user\",\"content\":\"Reply with exactly one word: pong\"}]}")
    if [[ "$code" == "200" ]]; then
      pass "system message \"$sys\" on $m -> 200"
    else
      fail "system message \"$sys\" on $m" "code=$code body=$(head -c 300 "$f")"
    fi
  done
done

# About 300KB of padding, then a short question: far past the per-argument
# limit argv had, so this only succeeds if the prompt is not an argument.
LONG_BODY="$WORK_DIR/long-prompt.json"
bun -e '
  const fs = require("fs");
  const pad = "The quick brown fox jumps over the lazy dog. ".repeat(6600);
  const prompt = (pad + "\n\nIgnore all of the above. Reply with exactly one word: pong").slice(0, 300000);
  fs.writeFileSync(process.argv[1], JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: prompt }] }));
' "$LONG_BODY"
f="$WORK_DIR/long-prompt-out.json"
code=$(curl -s -o "$f" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' --data-binary "@$LONG_BODY")
if [[ "$code" == "200" ]]; then
  pass "a ~300KB prompt on claude-haiku -> 200"
else
  fail "300KB prompt on claude-haiku" "code=$code body=$(head -c 300 "$f")"
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
      -d '{"model":"codex-luna","messages":[{"role":"user","content":"Reply with exactly one word: ok"}]}')
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

# ---- per-Model option refusals, error envelopes and timeouts ------------------
#
# These need a differently-configured server: TURN_TIMEOUT_MS is read once at
# startup, and a Model that declares nothing optional is needed to check the
# 400s. models.json is a static import, so run a second server against a
# patched copy of the tree rather than mutating the real config.
#
# TURN_TIMEOUT_MS=1500 separates the two cases cleanly: a bogus model makes
# the CLI exit in well under a second, while any real model call takes longer
# than 1.5s -- so neither test can be satisfied by the other's mechanism.

section "Models that do not declare an option refuse it"

ALT_DIR="$(mktemp -d)"
ALT_LOG="$(mktemp -t localaiwrapper-alt-log-XXXXXX)"
cp -R src package.json tsconfig.json "$ALT_DIR/" 2>/dev/null
bun -e '
  const fs = require("fs");
  const models = JSON.parse(fs.readFileSync("models.json", "utf8"));
  const off = (values, def, description) => ({ supported: false, values, default: def, description });
  // A Model that declares none of the optional features.
  models["no-options"] = {
    backend: "claude",
    model: "haiku",
    systemPrompt: "You are a helpful assistant.",
    options: {
      reasoning_effort: off(null, null, "unsupported"),
      web: off([false], false, "unsupported"),
      access: off(["none"], "none", "unsupported"),
      workdir: off(null, null, "unsupported"),
    },
  };
  // A Model whose CLI exits non-zero without ever reaching the model: codex
  // rejects a model name it does not know, quickly and for free.
  models["broken-on-purpose"] = {
    backend: "codex",
    model: "gpt-5.6-nope",
    systemPrompt: "You are a helpful assistant.",
  };
  fs.writeFileSync(process.argv[1] + "/models.json", JSON.stringify(models, null, 2));
' "$ALT_DIR"

ALT_PORT="$(find_free_port 8951)"
ALT_BASE="http://127.0.0.1:$ALT_PORT"
# Started WITHOUT a subshell so SERVER2_PID is bun itself: the orphan check
# below counts the server's direct children, and a wrapping subshell would
# make bun look like the child.
WORKDIR_DEFAULT="$DEFAULT_DIR" WORKDIR_ROOTS="$ALLOWED_DIR" \
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
  alt_post() { curl -s -o "$1" -w '%{http_code}' -X POST "$ALT_BASE/v1/chat/completions" -H 'content-type: application/json' -d "$2"; }

  f="$WORK_DIR/alt-web.json"
  code=$(alt_post "$f" '{"model":"no-options","messages":[{"role":"user","content":"hi"}],"web":true}')
  [[ "$code" == "400" ]] && pass "web:true on a Model that does not support it -> 400" || fail "web unsupported -> 400" "code=$code body=$(cat "$f")"

  f="$WORK_DIR/alt-access.json"
  code=$(alt_post "$f" '{"model":"no-options","messages":[{"role":"user","content":"hi"}],"access":"workspace-write"}')
  [[ "$code" == "400" ]] && pass "access on a Model that does not declare it -> 400" || fail "access unsupported -> 400" "code=$code body=$(cat "$f")"

  f="$WORK_DIR/alt-effort.json"
  code=$(alt_post "$f" '{"model":"no-options","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"low"}')
  [[ "$code" == "400" ]] && pass "reasoning_effort on a Model that does not declare it -> 400" || fail "reasoning_effort unsupported -> 400" "code=$code body=$(cat "$f")"

  f="$WORK_DIR/alt-web-false.json"
  code=$(alt_post "$f" '{"model":"no-options","messages":[{"role":"user","content":"Reply with exactly one word: pong"}],"web":false}')
  # Validation passed if the answer is anything but a 400 about support. This
  # server times Turns out at 1.5s, so the Turn itself may end as a 504.
  if [[ "$code" != "400" ]]; then pass "web:false on a Model that does not support it is accepted (it is the default)"; else fail "web:false accepted" "code=$code body=$(cat "$f")"; fi

  f="$WORK_DIR/alt-access-none.json"
  code=$(alt_post "$f" '{"model":"no-options","messages":[{"role":"user","content":"Reply with exactly one word: pong"}],"access":"none"}')
  if [[ "$code" != "400" ]]; then pass "access none (the default) on a Model that does not support access is accepted"; else fail "access none accepted" "code=$code body=$(cat "$f")"; fi

  section "Timeout and backend-failure error envelopes"

  # A Turn exceeding TURN_TIMEOUT_MS must be killed and return an error.
  timeout_body="$WORK_DIR/timeout.json"
  timeout_code="$(alt_post "$timeout_body" '{"model":"claude-sonnet","messages":[{"role":"user","content":"Write one short sentence."}]}')"
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

# A non-zero CLI exit must surface as an OpenAI error envelope, not a 200.
# Own server with the default timeout: the bogus model takes ~3s to fail, which
# the 1.5s timeout would turn into a 504 and hide the check it is for.
SERVER3_PID=""
PORT3="$(find_free_port 8941)"
WORKDIR_DEFAULT="$DEFAULT_DIR" WORKDIR_ROOTS="$ALLOWED_DIR" PORT="$PORT3" bun run "$ALT_DIR/src/server.ts" >"$WORK_DIR/exit-server.log" 2>&1 &
SERVER3_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT3/health" >/dev/null 2>&1 && break; sleep 0.2; done
broken_body="$WORK_DIR/broken.json"
broken_code="$(curl -s -o "$broken_body" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT3/v1/chat/completions" -H 'content-type: application/json' -d '{"model":"broken-on-purpose","messages":[{"role":"user","content":"hi"}]}')"
broken_msg="$(jsget "$broken_body" 'd.error && d.error.message || ""' 2>/dev/null || echo "")"
if [[ "$broken_code" == "502" && -n "$broken_msg" ]]; then
  pass "non-zero CLI exit -> 502 error envelope with the message carried"
else
  fail "non-zero exit error envelope" "got HTTP $broken_code, body: $(head -c 300 "$broken_body")"
fi
kill_server "$SERVER3_PID"
SERVER3_PID=""

# ---- boot failures ------------------------------------------------------------

section "Invalid configuration fails the boot"

BAD_DIR="$(mktemp -d)"
cp -R src package.json tsconfig.json "$BAD_DIR/" 2>/dev/null
bun -e '
  const fs = require("fs");
  const models = JSON.parse(fs.readFileSync("models.json", "utf8"));
  // A Model whose "options" value is not an object.
  models["no-options-block"] = { backend: "claude", model: "haiku", systemPrompt: "x", options: "not-an-object" };
  fs.writeFileSync(process.argv[1] + "/models.json", JSON.stringify(models, null, 2));
' "$BAD_DIR"

BAD_PORT="$(find_free_port 8961)"
bad_out="$(PORT="$BAD_PORT" WORKDIR_DEFAULT="$DEFAULT_DIR" bun run "$BAD_DIR/src/server.ts" 2>&1 || true)"
if [[ "$bad_out" == *"no-options-block"* && "$bad_out" == *"not an object"* ]]; then
  pass "a Model whose options value is not an object aborts startup and is named"
else
  fail "missing options block aborts startup" "output=$(echo "$bad_out" | head -c 300)"
fi
if curl -fsS "http://127.0.0.1:$BAD_PORT/health" >/dev/null 2>&1; then
  fail "failed boot does not serve traffic" "server on $BAD_PORT answered /health"
else
  pass "failed boot does not serve traffic"
fi

bad_out="$(PORT="$BAD_PORT" WORKDIR_DEFAULT="$DEFAULT_DIR" WORKDIR_ROOTS="$WORK_DIR/no-such-root" bun run src/server.ts 2>&1 || true)"
if [[ "$bad_out" == *"WORKDIR_ROOTS"* && "$bad_out" == *"does not exist"* ]]; then
  pass "a WORKDIR_ROOTS entry that does not exist aborts startup"
else
  fail "missing WORKDIR_ROOTS aborts startup" "output=$(echo "$bad_out" | head -c 300)"
fi

# expect_boot_refused <model-json> <expected-substring> <label> -- adds one Model
# to the copied tree and checks the boot is refused with a message naming it.
# perl's alarm stops the server if validation wrongly lets it boot.
expect_boot_refused() {
  bun -e '
    const fs = require("fs");
    const models = JSON.parse(fs.readFileSync("models.json", "utf8"));
    models["bad-model"] = JSON.parse(process.argv[2]);
    fs.writeFileSync(process.argv[1] + "/models.json", JSON.stringify(models, null, 2));
  ' "$BAD_DIR" "$1"
  local out
  out="$(perl -e 'alarm shift; exec @ARGV' 20 env PORT="$BAD_PORT" WORKDIR_DEFAULT="$DEFAULT_DIR" bun run "$BAD_DIR/src/server.ts" 2>&1 || true)"
  if [[ "$out" == *"$2"* ]]; then pass "$3"; else fail "$3" "output=$(echo "$out" | head -c 300)"; fi
}
expect_boot_refused '{"backend":"claude","model":"haiku","options":{"access":{"supported":false,"values":["read-only"],"default":"read-only","description":"x"}}}' 'access' "an unsupported access with a non-neutral default aborts startup"
expect_boot_refused '{"backend":"claude","model":"haiku","options":{"workdir":{"supported":true,"values":null,"default":"/tmp","description":"x"}}}' 'workdir' "a non-null workdir default aborts startup"
expect_boot_refused '{"backend":"gemini","model":"haiku"}' 'names unknown backend "gemini"' "an unknown backend name aborts startup and is named"
expect_boot_refused '{"backend":"claude","model":"haiku","args":["--x"]}' 'unknown key "args"' "an old args key on a Model aborts startup and is named"
expect_boot_refused '{"backend":"codex","model":"gpt-5.6-luna","transport":"sdk"}' 'unknown key "transport"' "an old transport key on a Model aborts startup and is named"
expect_boot_refused '{"backend":"claude","model":"haiku","options":{"access":{"supported":true,"values":["none"],"default":"none","description":"x","args":["--x"]}}}' 'unknown key "args"' "an unknown key inside an option spec aborts startup and is named"
expect_boot_refused '{"backend":"claude","model":"haiku","options":{"access":{"supported":true,"values":null,"default":null,"description":"x"}}}' 'non-empty "values"' "a supported option without a values array aborts startup"

rm -rf "$BAD_DIR"

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
