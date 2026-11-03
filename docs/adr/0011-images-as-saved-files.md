# Images reach the CLIs as saved files

OpenAI clients send `content` as an array of parts, including `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`. The wrapper used to type `content` as a string, so images were never read (the model saw `[object Object]`). All three CLIs can look at local image files, so the fix is to decode each image to a file and give the CLI that file.

## Decision

- **Content parts are flattened to text first** (`extractImages` in `src/openai.ts`, pure). In a message that holds an image, parts are joined with a newline and each image becomes an `[image N]` placeholder at its position; in a message without one, text parts join with no separator, exactly as tool-call emulation always read them. Unknown part types without text are ignored as before, but media types (`input_audio`, `file`, `video`) are a 400 rather than silently dropped. Everything downstream (`checkMessages`, `flattenMessages`, tool-call emulation, `response_format`) sees text-only messages. String content is returned untouched, so a plain request produces the same prompt and argv as before.
- **Only `data:` URLs** (the scheme and `;base64` are case-insensitive, media-type parameters are allowed, base64 may be unpadded or URL-safe). Supported types are png, jpeg, gif and webp. `http(s)` and `file:` URLs are a 400: fetching a client-supplied URL would be an SSRF surface (the server can be bound to `0.0.0.0`), and everything this server serves is local. Unknown part types (audio, file) are a 400 naming the type.
- **Limits** `MAX_IMAGES` (8) and `MAX_IMAGE_BYTES` (10 MiB, decoded), both 400 when exceeded. The size is checked from the base64 length before decoding.
- **A fresh directory per Turn** (`mkdtemp`), files `img-1.png`, `img-2.jpg`, ... The directory is written only after the request is validated and a concurrency slot is held, and removed in the same `settle()` that releases the slot, which every exit path goes through (success, failure, client abort, timeout, failed spawn). It is not the Workdir, so `access` and `workdir` are unchanged.
- **Per Backend:**
  - claude: `Read` is added to `--tools` and `--allowed-tools` (no Glob or Grep) and the paths are appended to the prompt. Claude's `Read` returns image blocks.
  - commandcode: the paths are appended to the prompt, one per line (`- /path`); its headless file read returns images.
  - codex: `-i <file>` per image, because a model cannot view an image by reading it as text. The paths are also listed in the prompt.
- **Every Model is assumed to accept images.** There is no per-Model `vision` flag; if a Model cannot see, the CLI's own answer or error surfaces. Measured: `commandcode/deepseek/deepseek-v4-flash` answered a red image with "Magenta" (text-only Model), while claude-haiku, codex-luna, `deepseek-v4-flash-vision-exp`, `kimi-k3` and `qwen3.8-omni-flash` answered "Red".

## Consequences

- **`Read` is not a sandbox** (ADR 0007). An image Turn on claude gives the model a tool that accepts any absolute path, so it can read any file the user can, even with `access` `none`. This is accepted because the prompt comes from a trusted local client; `access` stays as requested and gives no tools beyond `Read` for the image. The same holds for commandcode's file read and for codex's read-only sandbox, which can read outside the Workdir anyway.
- Images are plain files in the system temp directory for the length of the Turn, readable by the user's other processes.
- Text-only streaming and non-streaming are unaffected; an image Turn streams like any other.
