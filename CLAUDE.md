# CLAUDE.md

Single-file Node proxy that keeps Codex sessions usable against DeepSeek's gateway: it
defuses the 48 MiB request-body cap that screenshots blow through, and repairs one item
shape that Codex's thread delegation emits and DeepSeek's API rejects. Read `README.md`
for the user-facing guide; this file is the working notes for changing the code.

## What it does

Codex stores tool screenshots as inline `data:image/...;base64,...` inside
`function_call_output` items and replays the entire conversation every turn. DeepSeek's
gateway caps the body at 48 MiB (50,331,648 bytes), so image-heavy threads eventually get
`413 Failed to buffer the request body: length limit exceeded` on **every** turn — the
history only grows, so it never self-heals.

The proxy sits between Codex and `api.deepseek.com`, pulls each data URI out of the
outbound request, uploads the bytes to DeepSeek's Files API (content-addressed, cached),
and rewrites the part to a ~60-byte `file_id` reference. The model still sees every image.

Measured: `49.11 MB -> 2.51 MB`, 148 screenshots preserved.

## The second job: orphan tool outputs

Codex's `create_thread` delegation (the desktop app's "continue this work in a new thread")
seeds the new thread with a `function_call_output` for the delegation — but with no
`call_id`, and nothing pairing with it. DeepSeek rejects that shape outright:

```
422 ... input: missing field `call_id`
```

on **every** turn, because Codex replays the item forever, exactly like the 413 case. The
proxy rewrites that one item into a plain user message holding the same `output` text, so
the handoff stays visible to the model and the thread recovers. Observed 2026-09-27.

## Layout

```
image-offload-proxy.mjs    the whole thing — no deps beyond Node 18+
README.md                  user-facing usage guide
CLAUDE.md                  this file
```

Runtime state deliberately lives **outside** the repo, under `%USERPROFILE%\.codex`
(override with `CODEX_HOME`):

| File | Purpose |
|---|---|
| `image-offload-cache.json` | `sha256(image bytes)` → `file_id`. Do not delete; re-uploading 148 images is slow |
| `image-offload-proxy.log` | one line per request |

## Running

```powershell
node image-offload-proxy.mjs
# -> http://127.0.0.1:8788   (CODEX_IMG_PROXY_PORT to change)
```

Codex must point at it: `~/.codex/config.toml` → `[model_providers.custom] base_url`.

Health check: `Invoke-WebRequest http://127.0.0.1:8788/health`

## Testing a change

There is no test suite. Verify end-to-end against the real API:

1. Start the proxy.
2. POST a `/responses` body containing an `input_image` whose data URI is **larger than
   `MIN_OFFLOAD_BYTES`** (64 KiB), with a prompt asking the model to describe it.
3. Check the log line: expect `body X -> Y MB (images 1/1 offloaded, saved ... MB)`.
4. **Confirm the model still answers correctly about the image.** A green log line alone
   does not prove the image survived — early on, a magenta test image was used to confirm
   both the data-URI and file_id paths returned "magenta".

Two traps when writing that test:
- A solid-colour or LCG-generated PNG compresses to a few KB and silently skips the
  offload path. Use `crypto.randomBytes` for incompressible pixels.
- Use a throwaway key path or delete the scratch script — it will contain an API key.

The repair path has the same trap, and the same remedy: a 200 does not prove the text
survived. POST an orphan `function_call_output` (no `call_id`, no matching `function_call`)
and ask the model to quote a distinctive string out of its `output`. Against an unpatched
proxy the identical body returns the 422 above.

## Invariants

- **Images must stay visible to the model.** This is the whole point. A change that drops,
  downscales, or replaces images with text/placeholders breaks the requirement even if it
  makes the request smaller. The user's constraint is explicit and non-negotiable.
- **Never re-serialize the request body.** The rewrite is a targeted regex over the raw
  string so the bytes *around* each image are preserved verbatim (prompt-cache prefix).
  Parsing and re-stringifying the 49 MB body would churn everything.
- **Only rewrite shapes Codex actually emits**: `"image_url": "data:image/...;base64,..."`
  and the orphan `function_call_output` described above. Anything else passes through
  untouched. If Codex changes its serialization the proxy goes quietly inert — `offloaded`
  in the log drops to 0, which is the signal.
- **Repair an orphan tool output by rewriting it into a message, never by inventing a
  `call_id`.** A `call_id` alone gets `400 No tool call found for tool output with call_id
  ...`; synthesizing the paired `function_call` as well gets `400 The reasoning_text in the
  thinking mode must be passed back`. Rewriting to a user message sidesteps tool bookkeeping
  entirely. `N orphan tool-output -> user message` in the log is the counter to watch.
- **Fail open.** An upload failure leaves that image inline rather than erroring the
  request. `left inline` in the log is the counter to watch.

## Gotchas

- **Codex caches its config in memory.** Editing `config.toml` requires restarting *both*
  the Desktop app and the `codex.exe app-server` child process — the app-server is what
  reads the file. Restarting only the UI does nothing.
- **CC Switch overwrites `base_url`.** It manages `config.toml`; switching providers there
  silently bypasses the proxy. It must stay closed while the proxy is in use.
- **`file_id` expires server-side (~30 days observed).** The proxy has no re-upload logic.
  A stale id will surface as an image error from upstream. This is the main reason the
  whole thing is a stopgap.
- **First request after a batch of new images is slow** — it uploads them and the upstream
  pays a cold image prefill. That combination has been observed to trip the upstream
  gateway's timeout, severing the stream (`stream closed before response.completed`).
  Retrying works because the prefix cache is warm. Do not confuse this with a proxy bug.
- Node's `Uint8Array.toString('utf8')` **ignores the argument** when the array comes from a
  web `ReadableStream` — it returns comma-separated byte values. Use `TextDecoder` with
  `{stream: true}` for SSE inspection.

## Deliberately not implemented

- File-id renewal / re-upload on expiry.
- Auto-start / service installation. Started by hand; it is a temporary workaround.
- Retrying a severed stream. Codex retries; doing it in the proxy would duplicate content.

The long-term plan is to move to a harness that speaks `file_id` natively (dsh's
`dsh-llm-deepseek` uploads via `/v1/files` and references by id by default). Treat this
repo as a bridge, not a destination.
