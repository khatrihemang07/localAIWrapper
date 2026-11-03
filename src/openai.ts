// OpenAI-shaped request/response types, message flattening, SSE framing,
// and the error envelope. Kept independent of any Backend.

import { decodeDataUrl, imageLimits, type DecodedImage, type ImageLimits } from "./images.ts";

export type ChatRole = "system" | "user" | "assistant";

/** A message as the Backends and flattenMessages see it: text only. */
export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } | string };

/** A message as a client sends it: `content` is a string or an array of parts. */
export type RequestMessage = {
  role: ChatRole;
  content: string | ContentPart[];
};

export type ChatCompletionRequest = {
  model: string;
  messages: RequestMessage[];
  stream?: boolean;
  /** Validated against the resolved Model in src/requestOptions.ts. */
  reasoning_effort?: string;
  web?: boolean;
  access?: string;
  workdir?: string;
  response_format?: unknown;
  // Tool calling is rejected with 400 unless TOOL_EMULATION=1 (see the guard in
  // server.ts and src/toolEmulation.ts), never silently stripped.
  tools?: unknown[];
  functions?: unknown[];
  tool_choice?: unknown;
};

export type ChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: {
        role: "assistant";
        content: string | null;
        tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
      };
      finish_reason: "stop" | "tool_calls";
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
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason: "stop" | "tool_calls" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type ExtractResult =
  | { ok: true; messages: Array<Record<string, unknown>>; images: DecodedImage[] }
  | { ok: false; message: string };

/**
 * Turns content-part arrays into text. Text parts are joined with a newline and
 * each image becomes an `[image N]` placeholder at its position, so "the second
 * image" still means something in the prompt; the decoded images are returned
 * in that order. Messages whose `content` is not an array (a string, null) are
 * returned as they came, so a plain request is unchanged, and every other field
 * (tool_calls, tool_call_id, ...) is kept for the tool-call emulation. Pure:
 * nothing is written anywhere.
 */
/** Part types that carry media this server cannot pass on: a 400, not a silent drop. */
const MEDIA_PART_TYPES = new Set(["input_audio", "audio", "file", "input_file", "video", "video_url", "input_image"]);

export function extractImages(messages: unknown[], limits: ImageLimits = imageLimits()): ExtractResult {
  type Part = { type?: unknown; text?: unknown; image_url?: unknown } | null;
  const images: DecodedImage[] = [];
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages as Array<Record<string, unknown>>) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const texts: string[] = [];
    let messageHasImage = false;
    for (const part of m.content as Part[]) {
      const type = part?.type;
      if (type === "image_url") {
        messageHasImage = true;
        const raw = part!.image_url;
        const url = typeof raw === "string" ? raw : (raw as { url?: unknown } | null)?.url;
        if (typeof url !== "string") return { ok: false, message: 'an "image_url" part needs an "image_url.url" string' };
        if (images.length >= limits.maxImages) {
          return { ok: false, message: `too many images; the limit is ${limits.maxImages} (MAX_IMAGES)` };
        }
        const decoded = decodeDataUrl(url, limits.maxBytes);
        if (!decoded.ok) return { ok: false, message: decoded.message };
        images.push(decoded.value);
        texts.push(`[image ${images.length}]`);
      } else if (typeof type === "string" && MEDIA_PART_TYPES.has(type)) {
        // Media that would otherwise vanish from the prompt: refuse, never drop.
        return { ok: false, message: `unsupported content part type "${type}"; only "text" and "image_url" are supported` };
      } else if (type === "text" && typeof part!.text !== "string") {
        return { ok: false, message: 'a "text" content part needs a "text" string' };
      } else if (typeof part?.text === "string") {
        texts.push(part.text);
      }
      // Any other part without text is ignored, as it was before images.
    }
    // Without images the parts join as before (no separator); an image message
    // puts each part, placeholders included, on its own line.
    out.push({ ...m, content: texts.join(messageHasImage ? "\n" : "") });
  }
  return { ok: true, messages: out, images };
}

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

/**
 * A prompt needs at least one user or assistant message. A system-only list
 * has nothing for the Turn to answer, so it is refused before any CLI spawns.
 * Returns the 400 message, or undefined when the list is acceptable.
 */
export function checkMessages(messages: ChatMessage[]): string | undefined {
  const hasTurn = messages.some((m) => m.role === "user" || m.role === "assistant");
  return hasTurn ? undefined : `"messages" must include at least one "user" or "assistant" message`;
}

export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function completionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function errorResponse(
  message: string,
  status: number,
  type = "invalid_request_error",
  code: string | null = null,
): Response {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
