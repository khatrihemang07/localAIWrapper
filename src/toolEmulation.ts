// Opt-in OpenAI tool-calling emulation (TOOL_EMULATION=1). The CLIs behind a
// Backend have no way to hand back a structured tool call, so the tool schemas
// are put into the system prompt, the model is told to answer with
// <tool_call>{...}</tool_call> blocks, and those blocks are parsed back into
// OpenAI `tool_calls`. The wrapper still runs no tools itself: the client owns
// the loop and sends results back as `role: "tool"` messages. See
// docs/adr/0009-opt-in-tool-call-emulation.md.

import type { ChatMessage } from "./openai.ts";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ToolDef = { name: string; description?: string; parameters?: unknown };

export type ToolEmulation = {
  /** Prompt-ready history: tool messages and tool_calls flattened to text. */
  messages: ChatMessage[];
  /** Appended to the Turn's system prompt. Empty when no tools are offered. */
  instructions: string;
  /** Names the model may call. Empty when tool_choice is "none". */
  toolNames: Set<string>;
};

type PrepareResult = { ok: true; value: ToolEmulation } | { ok: false; message: string };

/** OpenAI lets `content` be a string, null, or an array of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function renderCall(name: string, args: unknown): string {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = args;
    }
  }
  return `<tool_call>${JSON.stringify({ name, arguments: parsed ?? {} })}</tool_call>`;
}

/** Collects tool definitions from `tools` and the legacy `functions` field. */
function collectTools(body: { tools?: unknown; functions?: unknown }): ToolDef[] | string {
  const defs: ToolDef[] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return '"tools" must be an array';
    for (const t of body.tools as Array<{ type?: string; function?: ToolDef }>) {
      if (t?.type !== "function" || typeof t.function?.name !== "string") {
        return 'each "tools" entry must be {"type":"function","function":{"name":...}}';
      }
      defs.push(t.function);
    }
  }
  if (body.functions !== undefined) {
    if (!Array.isArray(body.functions)) return '"functions" must be an array';
    for (const f of body.functions as ToolDef[]) {
      if (typeof f?.name !== "string") return 'each "functions" entry needs a "name"';
      defs.push(f);
    }
  }
  return defs;
}

export function prepareToolEmulation(body: {
  messages: Array<Record<string, unknown>>;
  tools?: unknown;
  functions?: unknown;
  tool_choice?: unknown;
}): PrepareResult {
  const defs = collectTools(body);
  if (typeof defs === "string") return { ok: false, message: defs };

  const choice = body.tool_choice;
  const forced =
    typeof choice === "object" && choice !== null
      ? (choice as { function?: { name?: string } }).function?.name
      : undefined;
  const disabled = choice === "none";
  const offered = disabled ? [] : forced ? defs.filter((d) => d.name === forced) : defs;
  if (forced && offered.length === 0) return { ok: false, message: `"tool_choice" names unknown tool "${forced}"` };

  // Flatten tool-protocol messages to plain user/assistant text so everything
  // downstream (flattenMessages, the Backends) stays unaware of tools.
  const callNames = new Map<string, string>();
  const messages: ChatMessage[] = [];
  for (const m of body.messages) {
    const role = m.role;
    if (role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCall[]) : [];
      const parts: string[] = [];
      const text = textOf(m.content);
      if (text) parts.push(text);
      for (const c of calls) {
        callNames.set(c.id, c.function?.name ?? "unknown");
        parts.push(renderCall(c.function?.name ?? "unknown", c.function?.arguments));
      }
      messages.push({ role: "assistant", content: parts.join("\n") });
    } else if (role === "tool" || role === "function") {
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : "";
      const name = (typeof m.name === "string" && m.name) || callNames.get(id) || "unknown";
      messages.push({ role: "user", content: `<tool_result name="${name}" id="${id}">\n${textOf(m.content)}\n</tool_result>` });
    } else if (role === "system" || role === "developer" || role === "user") {
      messages.push({ role: role === "developer" ? "system" : role, content: textOf(m.content) });
    } else {
      return { ok: false, message: `unsupported message role "${String(role)}"` };
    }
  }

  const required = choice === "required" || Boolean(forced);
  const sawToolHistory = messages.some((m) => m.content.includes("<tool_call>") || m.content.includes("<tool_result"));
  const instructions =
    offered.length === 0
      ? sawToolHistory
        ? "No tools are available in this reply. Earlier <tool_call> and <tool_result> blocks are history only: answer in plain text and never write a <tool_call> block."
        : ""
      : [
          "# Tool calling",
          "You can call the tools listed below. To call tools, reply with ONLY blocks of exactly this form and no other text:",
          '<tool_call>{"name": "<tool name>", "arguments": {<JSON matching the tool schema>}}</tool_call>',
          "Rules:",
          "- Use one block per call. Emit several blocks in one reply to call tools in parallel.",
          '- The results arrive in the next message as <tool_result name="..." id="..."> blocks. Never write a tool result yourself, and stop right after your last block.',
          "- Arguments must be valid JSON that follows the tool's parameter schema. Use only the tool names listed.",
          "- Use no other tool syntax (no <invoke>, <parameter>, or function-call markup).",
          required
            ? "- You must call a tool in this reply."
            : "- When you have what you need, or no tool fits, answer in plain text with no <tool_call> block.",
          "",
          "Tools (JSON):",
          JSON.stringify(offered.map((d) => ({ name: d.name, description: d.description ?? "", parameters: d.parameters ?? { type: "object", properties: {} } }))),
        ].join("\n");

  return { ok: true, value: { messages, instructions, toolNames: new Set(offered.map((d) => d.name)) } };
}

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/g;

function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1]! : s).trim();
}

/**
 * Splits a reply into prose and tool calls. Anything after the first call is
 * dropped: it can only be the model inventing a result. Blocks that do not
 * parse, or name a tool that was not offered, are ignored and stay out of the
 * calls (the prose before them is kept).
 */
export function parseToolReply(text: string, toolNames: Set<string>): { content: string | null; toolCalls: ToolCall[] } {
  const calls: ToolCall[] = [];
  let firstIndex = -1;
  for (const match of text.matchAll(BLOCK)) {
    let obj: unknown;
    try {
      obj = JSON.parse(stripFence(match[1]!));
    } catch {
      continue;
    }
    const o = obj as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof o?.name !== "string" || !toolNames.has(o.name)) continue;
    const args = o.arguments ?? o.parameters ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
    if (firstIndex < 0) firstIndex = match.index!;
    calls.push({
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function",
      function: { name: o.name, arguments: JSON.stringify(args) },
    });
  }
  if (calls.length === 0) return { content: text, toolCalls: [] };
  const prose = text.slice(0, firstIndex).trim();
  return { content: prose || null, toolCalls: calls };
}
