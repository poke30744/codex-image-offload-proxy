#!/usr/bin/env node
//
// Codex image-offload proxy  (temporary workaround)
//
// Codex persists tool screenshots as inline base64 data URIs inside
// function_call_output items, and replays the whole conversation every turn.
// DeepSeek's gateway caps the request body at 48 MiB, so an image-heavy thread
// eventually dies with "413 Failed to buffer the request body".
//
// This proxy sits between Codex and api.deepseek.com. It pulls each
// data:image/...;base64,... URI out of the outbound request, uploads the bytes
// to DeepSeek's Files API (once, keyed by content hash), and rewrites the part
// to a ~60-byte file_id reference. The model still sees every image; the
// request just stops carrying the pixels.
//
// It also repairs a second, unrelated shape: Codex's create_thread delegation
// emits a function_call_output with no call_id and nothing pairing with it,
// which DeepSeek answers with 422 "missing field `call_id`" on every turn.
// That item is rewritten into a plain user message. See the note above the
// repair functions.
//
// Files expire server-side (observed ceiling ~30 days), so this is a stopgap.
//
// Usage:  node image-offload-proxy.mjs
// Then point Codex's model provider base_url at http://127.0.0.1:8788
//
// Copyright (C) 2026 poke30744
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with
// this program. If not, see <https://www.gnu.org/licenses/>.

import http from 'node:http';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.CODEX_IMG_PROXY_PORT ?? 8788);
const UPSTREAM = process.env.CODEX_IMG_PROXY_UPSTREAM ?? 'https://api.deepseek.com';
const FILES_URL = `${UPSTREAM}/anthropic/v1/files`;
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.codex');
const CACHE_FILE = path.join(CODEX_HOME, 'image-offload-cache.json');
const LOG_FILE = path.join(CODEX_HOME, 'image-offload-proxy.log');

// Only rewrite images in place when the shape matches what Codex emits.
// Anything else passes through untouched.
const DATA_URI = /"(image_url|url)"\s*:\s*"(data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+))"/g;

const UPLOAD_CONCURRENCY = 4;
const UPLOAD_ATTEMPTS = 3;
const MIN_OFFLOAD_BYTES = 64 * 1024; // don't bother with tiny images
const UPLOAD_TIMEOUT_MS = 60_000;

let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  /* first run */
}

let cacheDirty = false;
function persistCache() {
  if (!cacheDirty) return;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    cacheDirty = false;
  } catch (e) {
    log(`cache write failed: ${e.message}`);
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* non-fatal */
  }
}

const mb = (n) => (n / 1048576).toFixed(2);

async function uploadImage(mime, b64, authHeader) {
  const hash = crypto.createHash('sha256').update(b64).digest('hex');
  if (cache[hash]) return cache[hash];

  const bytes = Buffer.from(b64, 'base64');
  const ext = mime === 'jpeg' ? 'jpg' : mime.replace(/[^a-z0-9]/gi, '');
  let lastErr;

  // Uploads intermittently fail with a bare "fetch failed" under concurrency.
  // Retry with backoff rather than leaving the image inline.
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: `image/${mime}` }), `img-${hash.slice(0, 12)}.${ext}`);
      const r = await fetch(FILES_URL, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: form,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`upload ${r.status}: ${(await r.text()).slice(0, 160)}`);
      const j = await r.json();
      if (!j?.id) throw new Error(`upload returned no id: ${JSON.stringify(j).slice(0, 160)}`);
      cache[hash] = j.id;
      cacheDirty = true;
      return j.id;
    } catch (e) {
      lastErr = e;
      if (attempt < UPLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/** Rewrite every offloadable data URI in the body. Returns { body, stats }. */
async function offload(body, authHeader) {
  const found = [...body.matchAll(DATA_URI)];
  if (found.length === 0) return { body, stats: { total: 0, offloaded: 0, failed: 0, before: 0, after: 0 } };

  // dedupe by content hash so a repeated screenshot costs one upload
  const unique = new Map(); // b64 -> { mime, key, len }
  for (const m of found) {
    const [, key, , mime, b64] = m;
    const len = m[0].length;
    if (len < MIN_OFFLOAD_BYTES) continue;
    if (!unique.has(b64)) unique.set(b64, { mime, key, len });
  }

  const results = new Map(); // b64 -> file_id
  const items = [...unique.entries()];
  for (let i = 0; i < items.length; i += UPLOAD_CONCURRENCY) {
    const batch = items.slice(i, i + UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async ([b64, meta]) => {
        try {
          const id = await uploadImage(meta.mime, b64, authHeader);
          results.set(b64, id);
        } catch (e) {
          log(`  ! upload failed (${mb(meta.len)} MB): ${e.message} — leaving this image inline`);
        }
      }),
    );
  }
  persistCache();

  // single pass, preserving everything around the replaced spans
  let out = '';
  let cursor = 0;
  let offloaded = 0;
  let failed = 0;
  for (const m of found) {
    const [whole, , , , b64] = m;
    const id = results.get(b64);
    const start = m.index;
    const end = start + whole.length;
    if (!id) {
      failed++;
      continue;
    }
    out += body.slice(cursor, start) + `"file_id":${JSON.stringify(id)}`;
    cursor = end;
    offloaded++;
  }
  out += body.slice(cursor);

  return {
    body: out,
    stats: {
      total: found.length,
      offloaded,
      failed,
      before: Buffer.byteLength(body, 'utf8'),
      after: Buffer.byteLength(out, 'utf8'),
    },
  };
}

// --- orphan tool-output repair ---------------------------------------------
//
// Codex's create_thread delegation (the desktop app's "continue this work in a
// new thread") seeds the new thread with a function_call_output for the
// delegation, but nothing pairs with it and it carries no call_id. The
// Responses API requires both, so DeepSeek rejects the whole request with
//
//   422 ... input: missing field `call_id`
//
// on every turn — Codex replays the item every time, so the thread never
// recovers. The same call shows up in the *source* thread as a function_call
// with no call_id either, so this is the app's own bookkeeping, not something
// we can round-trip faithfully.
//
// Supplying a call_id is not enough. Upstream then wants the paired call
// (400 "No tool call found for tool output with call_id ..."), and a
// synthesized call trips the thinking-mode round-trip check (400 "The
// `reasoning_text` in the thinking mode must be passed back"). So the item is
// rewritten into a plain user message holding the same text: the handoff stays
// visible to the model and no tool bookkeeping is invented. The output string
// is spliced in verbatim — like the image path, nothing here re-serializes the
// body.

const ORPHAN_OUTPUT_TYPE = /"type"\s*:\s*"function_call_output"/g;

const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/**
 * Parse the object starting at `s[start]` (which must be '{').
 * Returns { values, end }: `values` maps each direct key to the [from, to)
 * offsets of its raw value text, `end` is the offset of the closing '}'.
 * Values are located, never decoded, so nothing is re-serialized.
 * Returns null if the text is not a well-formed object.
 */
function parseObject(s, start) {
  const n = s.length;
  const values = new Map();
  let i = start + 1;

  const ws = () => {
    while (i < n && isWs(s[i])) i++;
  };
  /** s[j] is '"' -> offset just past the closing quote, else -1. */
  const strEnd = (j) => {
    for (j++; j < n; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '"') return j + 1;
    }
    return -1;
  };

  if (s[start] !== '{') return null;
  for (;;) {
    ws();
    if (s[i] === '}') return { values, end: i };
    if (s[i] !== '"') return null;
    const kEnd = strEnd(i);
    if (kEnd < 0) return null;
    const key = s.slice(i + 1, kEnd - 1);
    i = kEnd;
    ws();
    if (s[i] !== ':') return null;
    i++;
    ws();

    const from = i;
    if (s[i] === '"') {
      const e = strEnd(i);
      if (e < 0) return null;
      i = e;
    } else if (s[i] === '{' || s[i] === '[') {
      // skip a balanced container so commas inside it don't end the value
      const open = s[i];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      for (;;) {
        if (i >= n) return null;
        const c = s[i];
        if (c === '"') {
          const e = strEnd(i);
          if (e < 0) return null;
          i = e;
          continue;
        }
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          i++;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
    } else {
      while (i < n && s[i] !== ',' && s[i] !== '}') i++;
      while (i > from && isWs(s[i - 1])) i--;
    }

    values.set(key, [from, i]);
    ws();
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === '}') return { values, end: i };
    return null;
  }
}

/** True if the '{' at `j` opens an array element, i.e. follows '[' or ','. */
function isArrayElement(s, j) {
  let k = j - 1;
  while (k >= 0 && isWs(s[k])) k--;
  return k >= 0 && (s[k] === '[' || s[k] === ',');
}

/**
 * The object containing the `"type"` token at `at`. Normally the nearest '{'
 * to its left, but that can land inside an earlier string value, so walk
 * further left until one actually parses. Input items are array elements, so
 * anything else (a stray '{' inside a prompt or a tool output) is rejected —
 * that keeps the rewrite from firing on text that merely quotes this shape.
 */
function objectAround(s, at) {
  let j = at - 1;
  for (let tries = 0; tries < 5 && j >= 0; tries++) {
    while (j >= 0 && s[j] !== '{') j--;
    if (j < 0) return null;
    const obj = parseObject(s, j);
    if (obj && at < obj.end && isArrayElement(s, j)) return { start: j, obj };
    j--;
  }
  return null;
}

/** Rewrite every call_id-less function_call_output into a user message. */
function repairOrphanToolOutputs(body) {
  const hits = [...body.matchAll(ORPHAN_OUTPUT_TYPE)];
  if (hits.length === 0) return { body, repaired: 0 };

  let out = '';
  let cursor = 0;
  let repaired = 0;
  for (const hit of hits) {
    const found = objectAround(body, hit.index);
    if (!found || found.start < cursor) continue;
    // Only the exact shape: a function_call_output with no call_id and a
    // string output. Anything else is left alone.
    const type = found.obj.values.get('type');
    const output = found.obj.values.get('output');
    if (found.obj.values.has('call_id')) continue;
    if (!type || body.slice(type[0], type[1]) !== '"function_call_output"') continue;
    if (!output || body[output[0]] !== '"') {
      log(`  ! orphan tool-output at offset ${hit.index} has no string output — left alone`);
      continue;
    }
    out +=
      body.slice(cursor, found.start) +
      '{"type":"message","role":"user","content":[{"type":"input_text","text":' +
      body.slice(output[0], output[1]) +
      '}]}';
    cursor = found.obj.end + 1;
    repaired++;
  }
  if (repaired === 0) return { body, repaired: 0 };
  return { body: out + body.slice(cursor), repaired };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cached: Object.keys(cache).length, upstream: UPSTREAM }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }

  let raw;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    res.writeHead(400).end(String(e));
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  let body = raw;
  let stats = { total: 0, offloaded: 0, failed: 0, before: raw.length, after: raw.length };

  if (raw.includes('data:image/')) {
    try {
      ({ body, stats } = await offload(raw, authHeader));
    } catch (e) {
      log(`offload crashed, forwarding original: ${e.message}`);
      body = raw;
    }
  }

  // Runs after the image pass so the scan sees the smaller body.
  let repaired = 0;
  if (body.includes('function_call_output')) {
    try {
      const r = repairOrphanToolOutputs(body);
      body = r.body;
      repaired = r.repaired;
      if (repaired) stats.after = Buffer.byteLength(body, 'utf8');
    } catch (e) {
      log(`orphan tool-output repair crashed, forwarding as-is: ${e.message}`);
    }
  }

  // forward, minus hop-by-hop / length-derived headers
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: 'POST',
      headers,
      body,
    });
  } catch (e) {
    log(`upstream error: ${e.message}`);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `proxy: upstream unreachable: ${e.message}` } }));
    return;
  }

  const outHeaders = {};
  for (const [k, v] of upstream.headers) {
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) continue;
    outHeaders[k] = v;
  }
  res.writeHead(upstream.status, outHeaders);

  // Track SSE progress so we can tell a clean finish from a severed stream.
  // Codex reports "stream closed before response.completed" when the latter happens.
  let streamErr = null;
  let sawCompleted = false;
  let lastEvent = '(none)';
  let tail = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await once(res, 'drain');
      // chunk is a Uint8Array — decode explicitly, and stream:true so a
      // multibyte char split across chunks isn't mangled.
      tail += decoder.decode(chunk, { stream: true });
      if (tail.includes('response.completed')) sawCompleted = true;
      const m = [...tail.matchAll(/"type"\s*:\s*"([a-z0-9_.]+)"/g)].pop();
      if (m) lastEvent = m[1];
      if (tail.length > 16384) tail = tail.slice(-8192);
    }
  } catch (e) {
    streamErr = e.message;
  }
  res.end();

  const saved = stats.before - stats.after;
  const streamNote = streamErr
    ? `  !! stream ${streamErr} after "${lastEvent}"${sawCompleted ? ' (post-completion, harmless)' : ' WITHOUT response.completed'}`
    : '';
  log(
    `${req.url}  ${upstream.status}  ` +
      `body ${mb(stats.before)} -> ${mb(stats.after)} MB  ` +
      `(images ${stats.offloaded}/${stats.total} offloaded${stats.failed ? `, ${stats.failed} left inline` : ''}, ` +
      `saved ${mb(saved)} MB)${repaired ? `  [${repaired} orphan tool-output -> user message]` : ''}  ` +
      `${Date.now() - started}ms  last="${lastEvent}"${sawCompleted ? ' completed' : ''}${streamNote}`,
  );
});

server.listen(PORT, '127.0.0.1', () => {
  log(`codex image-offload proxy listening on http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`);
  log(`cache: ${CACHE_FILE} (${Object.keys(cache).length} images)`);
});
