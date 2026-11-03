// Images arrive as `data:` URLs inside a request's content parts. They are
// decoded here and, per Turn, saved to files the Backend's CLI can open. Pure
// decoding is kept apart from the filesystem part (saveImages) so the request
// can be refused before anything is written. See docs/adr/0011.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DecodedImage = { mime: string; bytes: Uint8Array };
export type SavedImage = { path: string; mime: string };
export type ImageLimits = { maxImages: number; maxBytes: number };

export const DEFAULT_MAX_IMAGES = 8;
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** MAX_IMAGES and MAX_IMAGE_BYTES from the environment, read per call. */
export function imageLimits(env: Record<string, string | undefined> = Bun.env): ImageLimits {
  return {
    maxImages: positiveInt(env.MAX_IMAGES, DEFAULT_MAX_IMAGES),
    maxBytes: positiveInt(env.MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES),
  };
}

// `data:` and `;base64` are case-insensitive, and media-type parameters
// (`;charset=utf-8`) may sit between the type and `;base64`.
const DATA_URL = /^data:([^;,]+)((?:;[^;,]*)*?);base64,(.*)$/is;
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

export type DecodeResult = { ok: true; value: DecodedImage } | { ok: false; message: string };

/** Decodes one `data:image/<png|jpeg|gif|webp>;base64,...` URL. Never throws. */
export function decodeDataUrl(url: string, maxBytes: number): DecodeResult {
  if (!/^data:/i.test(url)) {
    return { ok: false, message: "image_url must be a data: URL (data:image/png;base64,...); remote and file URLs are not supported" };
  }
  const match = DATA_URL.exec(url);
  if (!match) return { ok: false, message: "image_url is not a valid base64 data: URL" };
  const mime = match[1]!.trim().toLowerCase();
  if (!Object.hasOwn(EXTENSIONS, mime)) {
    return { ok: false, message: `unsupported image type "${mime}"; supported: png, jpeg, gif, webp` };
  }
  // Accept URL-safe (-_) and unpadded base64; validate the shape on the text.
  const body = match[3]!.replace(/\s+/g, "").replace(/={0,2}$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (body.length === 0 || body.length % 4 === 1 || !BASE64_BODY.test(body)) {
    return { ok: false, message: "image_url has invalid base64 data" };
  }
  // Size is checked from the text first so an oversized image is never decoded.
  const size = Math.floor((body.length * 3) / 4);
  if (size > maxBytes) {
    return { ok: false, message: `image is ${size} bytes; the limit is ${maxBytes} (MAX_IMAGE_BYTES)` };
  }
  const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
  return { ok: true, value: { mime, bytes: Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)) } };
}

/**
 * Writes the images into a fresh directory, `img-1.png`, `img-2.jpg`, ...
 * `cleanup` removes the directory and is safe to call more than once. If a
 * write fails, the directory is removed before the error propagates.
 */
export function saveImages(images: DecodedImage[], baseDir: string = tmpdir()): { images: SavedImage[]; cleanup: () => void } {
  if (images.length === 0) return { images: [], cleanup: () => {} };
  const dir = mkdtempSync(join(baseDir, "localaiwrapper-img-"));
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const saved = images.map((img, i) => {
      const path = join(dir, `img-${i + 1}.${EXTENSIONS[img.mime]}`);
      writeFileSync(path, img.bytes);
      return { path, mime: img.mime };
    });
    return { images: saved, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
