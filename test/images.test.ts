import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { checkMessages, extractImages, flattenMessages } from "../src/openai.ts";
import { decodeDataUrl, imageLimits, saveImages } from "../src/images.ts";
import { runCli } from "../src/backends/cli.ts";

const limits = { maxImages: 8, maxBytes: 1024 };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const url = (mime: string, s = "abc") => `data:${mime};base64,${b64(s)}`;
const img = (u: string) => ({ type: "image_url", image_url: { url: u } });

test("string content passes through untouched", () => {
  const msgs = [{ role: "user", content: "hi" }, { role: "assistant", content: null, tool_calls: [{ id: "1" }] }];
  const r = extractImages(msgs, limits);
  expect(r).toEqual({ ok: true, messages: msgs, images: [] });
});

test("mixed text and image parts become text with [image N] placeholders in order", () => {
  const r = extractImages(
    [{ role: "user", content: [{ type: "text", text: "compare" }, img(url("image/png", "one")), { type: "text", text: "with" }, img(url("image/jpeg", "two")), { type: "text", text: "now" }] }],
    limits,
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.messages[0]!.content).toBe("compare\n[image 1]\nwith\n[image 2]\nnow");
  expect(r.images.map((i) => i.mime)).toEqual(["image/png", "image/jpeg"]);
  expect(Buffer.from(r.images[1]!.bytes).toString()).toBe("two");
});

test("other message fields survive extraction, and the flattened prompt is plain text", () => {
  const r = extractImages([{ role: "user", name: "bob", content: [{ type: "text", text: "look" }, img(url("image/webp"))] }], limits);
  if (!r.ok) throw new Error(r.message);
  expect(r.messages[0]!.name).toBe("bob");
  expect(checkMessages(r.messages as never)).toBeUndefined();
  expect(flattenMessages(r.messages as never).prompt).toBe("Human: look\n[image 1]");
});

test("decodes png, jpeg, gif and webp", () => {
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const d = decodeDataUrl(url(mime), 100);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.mime).toBe(mime);
  }
});

const refused = (content: unknown, l = limits) => {
  const r = extractImages([{ role: "user", content }], l);
  if (r.ok) throw new Error("expected a refusal");
  return r.message;
};

test("an http(s) or file URL is refused with a message about data URLs", () => {
  expect(refused([img("http://example.com/a.png")])).toContain("data:");
  expect(refused([img("https://example.com/a.png")])).toContain("data:");
  expect(refused([img("file:///etc/passwd")])).toContain("data:");
});

test("bad base64 is refused", () => {
  expect(refused([img("data:image/png;base64,@@@@")])).toContain("base64");
  expect(refused([img("data:image/png;base64,abcde")])).toContain("base64");
  expect(refused([img("data:image/png;base64,")])).toContain("base64");
});

test("a non-image or unsupported mime is refused", () => {
  expect(refused([img(url("text/html"))])).toContain("text/html");
  expect(refused([img(url("image/svg+xml"))])).toContain("image/svg+xml");
});

test("too many images and too large an image are refused", () => {
  expect(refused([img(url("image/png")), img(url("image/png"))], { maxImages: 1, maxBytes: 1024 })).toContain("MAX_IMAGES");
  expect(refused([img(url("image/png", "x".repeat(50)))], { maxImages: 8, maxBytes: 10 })).toContain("MAX_IMAGE_BYTES");
});

test("an unknown part type names the type", () => {
  expect(refused([{ type: "input_audio", input_audio: {} }])).toContain("input_audio");
  expect(refused([{ type: "file", file: {} }])).toContain('"file"');
  expect(refused([{ type: "video_url", video_url: {} }])).toContain("video_url");
});

test("image_url without a url string is refused", () => {
  expect(refused([{ type: "image_url", image_url: {} }])).toContain("image_url.url");
});

test("limits come from MAX_IMAGES and MAX_IMAGE_BYTES, with defaults and bad values ignored", () => {
  expect(imageLimits({})).toEqual({ maxImages: 8, maxBytes: 10 * 1024 * 1024 });
  expect(imageLimits({ MAX_IMAGES: "2", MAX_IMAGE_BYTES: "500" })).toEqual({ maxImages: 2, maxBytes: 500 });
  expect(imageLimits({ MAX_IMAGES: "abc", MAX_IMAGE_BYTES: "-1" })).toEqual({ maxImages: 8, maxBytes: 10 * 1024 * 1024 });
});

test("saveImages writes the exact bytes into one fresh directory, and cleanup removes it (twice is fine)", () => {
  const saved = saveImages([
    { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    { mime: "image/jpeg", bytes: new Uint8Array([4, 5]) },
  ]);
  const [a, b] = saved.images;
  expect(a!.path.endsWith("img-1.png")).toBe(true);
  expect(b!.path.endsWith("img-2.jpg")).toBe(true);
  expect(dirname(a!.path)).toBe(dirname(b!.path));
  expect([...readFileSync(a!.path)]).toEqual([1, 2, 3]);
  saved.cleanup();
  expect(existsSync(dirname(a!.path))).toBe(false);
  saved.cleanup();
});

test("saveImages with no images creates nothing", () => {
  expect(saveImages([]).images).toEqual([]);
});

test("a directory cleaned after a failed spawn leaves nothing behind", () => {
  const saved = saveImages([{ mime: "image/gif", bytes: new Uint8Array([9]) }]);
  const dir = dirname(saved.images[0]!.path);
  expect(dir.startsWith(tmpdir().replace(/\/$/, ""))).toBe(true);
  expect(() =>
    runCli("/nonexistent/binary-xyz", [], () => null, new AbortController().signal, {
      cwd: process.cwd(),
      apiKeyVars: [],
      stdin: "",
      cleanup: saved.cleanup,
    }),
  ).toThrow();
  expect(existsSync(dir)).toBe(false);
});

test("tool-call emulation sees the text-only form with placeholders", async () => {
  const { prepareToolEmulation } = await import("../src/toolEmulation.ts");
  const r = extractImages([{ role: "user", content: [{ type: "text", text: "what is this" }, img(url("image/png"))] }], limits);
  if (!r.ok) throw new Error(r.message);
  const p = prepareToolEmulation({ messages: r.messages, tools: [{ type: "function", function: { name: "f" } }] });
  if (!p.ok) throw new Error(p.message);
  expect(p.value.messages[0]!.content).toBe("what is this\n[image 1]");
});

// ---- regression: requests without images behave as before ----

const text = (content: unknown) => {
  const r = extractImages([{ role: "tool", content }], limits);
  if (!r.ok) throw new Error(r.message);
  return r.messages[0]!.content;
};

test("without images, text parts join with no separator (a tool result split across parts)", async () => {
  expect(text([{ text: '{"a":' }, { text: "1}" }])).toBe('{"a":1}');
  const { prepareToolEmulation } = await import("../src/toolEmulation.ts");
  const r = extractImages(
    [{ role: "user", content: "go" }, { role: "tool", tool_call_id: "c", name: "f", content: [{ text: '{"a":' }, { text: "1}" }] }],
    limits,
  );
  if (!r.ok) throw new Error(r.message);
  const p = prepareToolEmulation({ messages: r.messages, tools: [{ type: "function", function: { name: "f" } }] });
  if (!p.ok) throw new Error(p.message);
  expect(p.value.messages[1]!.content).toContain('{"a":1}');
});

test("assistant, system and user text arrays are joined without a separator", () => {
  const r = extractImages(
    [
      { role: "system", content: [{ type: "text", text: "be " }, { type: "text", text: "brief" }] },
      { role: "assistant", content: [{ type: "text", text: "ab" }, { type: "text", text: "cd" }] },
      { role: "user", content: [{ type: "text", text: "x" }] },
    ],
    limits,
  );
  if (!r.ok) throw new Error(r.message);
  expect(r.messages.map((m) => m.content)).toEqual(["be brief", "abcd", "x"]);
});

test("an unknown non-media part type is ignored, as before", () => {
  expect(text([{ type: "refusal", refusal: "no" }, { type: "text", text: "kept" }])).toBe("kept");
  expect(text([{ type: "input_text", text: "kept too" }])).toBe("kept too");
  expect(text([{ type: "mystery" }, null, 5])).toBe("");
});

test("a text part without a string text gets an accurate error", () => {
  const m = refused([{ type: "text" }]);
  expect(m).toContain('"text" string');
  expect(m).not.toContain("unsupported content part type");
});

test("media parts are refused even when the request has no image", () => {
  expect(refused([{ type: "text", text: "hi" }, { type: "input_audio", input_audio: {} }])).toContain("input_audio");
});

// ---- data URL leniency ----

test("data: prefix and ;base64 are case-insensitive and media-type parameters are allowed", () => {
  for (const u of [`DATA:image/PNG;BASE64,${b64("abc")}`, `data:image/png;charset=utf-8;base64,${b64("abc")}`]) {
    const d = decodeDataUrl(u, 100);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.value.mime).toBe("image/png");
  }
});

test("unpadded and URL-safe base64 decode to the right bytes", () => {
  const bytes = new Uint8Array([251, 255, 254, 1, 2]); // standard form has + and /
  const std = Buffer.from(bytes).toString("base64");
  expect(std).toMatch(/[+/]/);
  const urlSafe = std.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  for (const body of [std, std.replace(/=+$/, ""), urlSafe]) {
    const d = decodeDataUrl(`data:image/png;base64,${body}`, 100);
    expect(d.ok).toBe(true);
    if (d.ok) expect([...d.value.bytes]).toEqual([...bytes]);
  }
});

test("shape is still validated and the size limit holds for unpadded input", () => {
  expect(decodeDataUrl("data:image/png;base64,a", 100).ok).toBe(false);
  expect(decodeDataUrl("data:image/png;base64,ab=c", 100).ok).toBe(false);
  expect(decodeDataUrl("data:image/png;base64,a+b*", 100).ok).toBe(false);
  const big = Buffer.from("x".repeat(60)).toString("base64").replace(/=+$/, "");
  const r = decodeDataUrl(`data:image/png;base64,${big}`, 10);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.message).toContain("MAX_IMAGE_BYTES");
});
