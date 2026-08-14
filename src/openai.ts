// OpenAI-shaped request/response types, message flattening, SSE framing,
// and the error envelope. Kept independent of any Backend.

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  // Tool calling is unsupported (see the /v1/chat/completions guard in
  // server.ts): these are typed here only so a request that includes them
  // can be detected and rejected with 400, never silently stripped.
  tools?: unknown[];
  functions?: unknown[];
};

export type ChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop";
    },
  ];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// `choices` is a regular array rather than a fixed one-element tuple because
// OpenAI's convention for the trailing usage chunk (see ADR 0003) is an
// otherwise-empty chunk carrying `choices: []` and a populated `usage`.
export type ChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    delta: { role?: "assistant"; content?: string };
    finish_reason: "stop" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// The server holds no state between Turns: every request resends the full
// message history, which gets flattened into a single prompt string here.
// Keeping this in one function means the flattening strategy (today: a
// Human:/Assistant: transcript) can be swapped in a single edit.
export function flattenMessages(messages: ChatMessage[]): { system?: string; prompt: string } {
  const systemParts: string[] = [];
  const turns: string[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      turns.push(`Human: ${m.content}`);
    } else if (m.role === "assistant") {
      turns.push(`Assistant: ${m.content}`);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    prompt: turns.join("\n\n"),
  };
}

export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function completionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function errorResponse(message: string, status: number, type = "invalid_request_error"): Response {
  return new Response(JSON.stringify({ error: { message, type, code: null } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
