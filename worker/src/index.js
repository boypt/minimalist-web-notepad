/**
 * Minimalist Web Notepad — Cloudflare Workers edition
 *
 * Port of the single-file PHP app in ../index.php (fork of
 * pereorga/minimalist-web-notepad) to a module Worker backed by D1.
 *
 * Behavioural parity with the PHP version is intentional:
 *   - GET  /                     -> 302 redirect to a random 5-char note id
 *   - GET  /:note                -> HTML editor
 *   - GET  /:note/:mode          -> stored note in that mode
 *                                   (plain, base64, md5, mtime,
 *                                    html, css, js, json; unknown == raw)
 *   - POST /:note  (form `text`) -> save; empty `text` deletes
 *   - POST /:note  (raw body)    -> CLI save
 *   - POST /:note/append         -> CLI append
 *   - curl user-agent            -> raw body, no HTML wrapper
 *
 * Differences from the PHP version:
 *   - Bodies are zstd-compressed (node:zlib) before they are written to D1.
 *   - Every row carries created_at / updated_at / expires_at; a Cron
 *     Trigger garbage-collects expired rows. Reads also lazily delete.
 *   - Password columns (password_hash / password_salt / password_algo /
 *     is_protected) are reserved for a future password-protected view.
 *     They are stored but not yet enforced.
 *
 * The helper exports below are exported so they can be unit-tested with
 * plain Node; the Worker entrypoint is the default export.
 */

import zlib from 'node:zlib';

const NOTE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MODE_RE = /^[a-z0-9]*$/;
const ID_ALPHABET = '234579abcdefghjkmnpqrstwxyz';
const DEFAULT_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Codec recorded in notes.content_encoding. */
const CODEC = 'zstd';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Shared response helpers
// ---------------------------------------------------------------------------

/** Cache headers shared by every response (mirrors the PHP version). */
function noStore(extra) {
  return {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  };
}

function redirect(location) {
  return new Response(null, { status: 302, headers: noStore({ Location: location }) });
}

function emptyOk() {
  return new Response('', {
    status: 200,
    headers: noStore({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: noStore({ 'Content-Type': 'text/plain; charset=utf-8' }),
  });
}

// ---------------------------------------------------------------------------
// Encoding / compression
// ---------------------------------------------------------------------------

/** Random note id from the unambiguous alphabet (same set as the PHP app). */
export function randomNoteId(length = 5) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < length; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

/**
 * zstd-compress a UTF-8 string, returning the raw compressed bytes.
 *
 * The Web Compression Streams API only supports gzip/deflate/deflate-raw in
 * Workers, so zstd comes from node:zlib (requires the `nodejs_compat` flag).
 */
export function compress(text) {
  return new Uint8Array(zlib.zstdCompressSync(encoder.encode(text)));
}

/**
 * Decompress bytes back to a UTF-8 string. `encoding` is the value stored in
 * notes.content_encoding; `gzip` is still decoded so data written by an
 * earlier gzip build remains readable.
 */
export function decompress(bytes, encoding = CODEC) {
  const input = toBytes(bytes);
  if (encoding === 'gzip') return decoder.decode(zlib.gunzipSync(input));
  if (encoding === 'identity' || encoding === 'none') return decoder.decode(input);
  return decoder.decode(zlib.zstdDecompressSync(input));
}

/**
 * D1 returns BLOB columns as an Array of byte values (despite the docs
 * saying ArrayBuffer). Normalise every accepted shape to Uint8Array.
 */
function toBytes(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  return new Uint8Array(0);
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// ---------------------------------------------------------------------------
// MD5 (Web Crypto does not implement MD5)
// ---------------------------------------------------------------------------

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function rotateLeft(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

function wordToHexLE(word) {
  let out = '';
  for (let i = 0; i < 4; i++) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  return out;
}

/** MD5 of a string (UTF-8) or byte array, returned as lowercase hex. */
export function md5(input) {
  const message = typeof input === 'string' ? encoder.encode(input) : input;
  const len = message.length;

  const paddedLength = len + 1 + (((56 - ((len + 1) % 64)) + 64) % 64) + 8;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(message);
  bytes[len] = 0x80;

  const view = new DataView(bytes.buffer);
  const bitLength = len * 8;
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + words[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(f, MD5_SHIFTS[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return [a0, b0, c0, d0].map(wordToHexLE).join('');
}

// ---------------------------------------------------------------------------
// D1 note store
// ---------------------------------------------------------------------------

async function deleteNote(env, id) {
  await env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
}

/**
 * Load a note and decompress its body.
 * Returns null when missing, or { expired: true } when past expires_at
 * (the caller schedules the delete).
 */
async function loadNote(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, content, content_encoding, updated_at, expires_at, is_protected
       FROM notes WHERE id = ? LIMIT 1`,
  ).bind(id).first();

  if (!row) return null;
  if (row.expires_at != null && row.expires_at < Date.now()) return { expired: true, row };

  let text = '';
  if (row.content != null) {
    const bytes = toBytes(row.content);
    text = decompress(bytes, row.content_encoding || CODEC);
  }
  return { expired: false, row, text };
}

/**
 * Insert or update a note. Content is always gzip-compressed before storage.
 * expires_at is (re)computed on every write; NOTE_TTL_DAYS = 0 disables expiry.
 */
async function saveNote(env, id, text, { append = false } = {}) {
  const now = Date.now();
  const ttlDays = Number(env.NOTE_TTL_DAYS ?? DEFAULT_TTL_DAYS);
  const expiresAt = ttlDays > 0 ? now + ttlDays * DAY_MS : null;

  let body = text;
  if (append) {
    const existing = await loadNote(env, id);
    const base = existing && !existing.expired ? existing.text : '';
    body = base + text;
  }

  const compressed = compress(body);
  const rawSize = encoder.encode(body).length;

  await env.DB.prepare(
    `INSERT INTO notes
       (id, content, content_encoding, size_raw, size_stored,
        created_at, updated_at, expires_at, is_protected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       content          = excluded.content,
       content_encoding = excluded.content_encoding,
       size_raw         = excluded.size_raw,
       size_stored      = excluded.size_stored,
       updated_at       = excluded.updated_at,
       expires_at       = excluded.expires_at`,
  ).bind(id, compressed, CODEC, rawSize, compressed.byteLength, now, now, expiresAt).run();
}

/** Delete every row whose expiry has passed (used by the Cron Trigger). */
async function gcExpired(env) {
  await env.DB.prepare(
    'DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?',
  ).bind(Date.now()).run();
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

async function handlePost(request, env, id, mode) {
  const contentType = request.headers.get('content-type') || '';
  const raw = await request.text();

  // Web (form) save path: the autosave XHR posts `text=...`.
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    if (params.has('text')) {
      const text = params.get('text') ?? '';
      if (text.length === 0) await deleteNote(env, id);
      else await saveNote(env, id, text);
      return emptyOk();
    }
  }

  // CLI path: raw request body. `mode=append` appends instead of overwriting.
  if (mode === 'append') await saveNote(env, id, raw, { append: true });
  else await saveNote(env, id, raw);
  return emptyOk();
}

function modeResponse(loaded, mode) {
  const text = loaded.text;
  const headers = (contentType) => noStore({ 'Content-Type': contentType });
  const plain = 'text/plain; charset=utf-8';

  switch (mode) {
    case 'plain':
      return new Response(text, { headers: headers(plain) });
    case 'base64':
      return new Response(bytesToBase64(encoder.encode(text)), { headers: headers(plain) });
    case 'md5':
      return new Response(md5(text), { headers: headers(plain) });
    case 'mtime':
      return new Response(String(Math.floor(loaded.row.updated_at / 1000)), {
        headers: headers(plain),
      });
    case 'html':
      return new Response(text, { headers: headers('text/html; charset=utf-8') });
    case 'css':
      return new Response(text, { headers: headers('text/css; charset=utf-8') });
    case 'js':
      return new Response(text, { headers: headers('text/javascript; charset=utf-8') });
    case 'json':
      return new Response(text, { headers: headers('application/json; charset=utf-8') });
    default:
      return new Response(text, { headers: headers(plain) });
  }
}

async function handleGet(request, env, ctx, id, mode) {
  let loaded = await loadNote(env, id);
  if (loaded && loaded.expired) {
    ctx.waitUntil(deleteNote(env, id));
    loaded = null;
  }

  if (mode) {
    if (!loaded) return redirect('/' + id);
    return modeResponse(loaded, mode);
  }

  const userAgent = request.headers.get('user-agent') || '';
  if (userAgent.startsWith('curl')) {
    return new Response(loaded ? loaded.text : '', {
      status: 200,
      headers: noStore({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }

  return new Response(renderPage(id, loaded ? loaded.text : ''), {
    status: 200,
    headers: noStore({ 'Content-Type': 'text/html; charset=utf-8' }),
  });
}

// ---------------------------------------------------------------------------
// HTML template (CSS + JS inlined, same as the PHP app)
// ---------------------------------------------------------------------------

function renderPage(id, text) {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="generator" content="Minimalist Web Notepad Developers Mod (Workers)">
    <title>${escapeHtml(id)}</title>
    <link rel="shortcut icon" href="/favicon.ico">
    <style>
/*! Minimalist Web Notepad | https://github.com/pereorga/minimalist-web-notepad */

body {
    margin: 0;
    background: #ebeef1;
}
.nav {
    margin: 10px 20px;
    font-size: small;
}
.nav a {
    display: inline;
    margin-right: 10px;
    color: grey;
}
.container {
    position: absolute;
    top: 40px;
    right: 20px;
    bottom: 20px;
    left: 20px;
}
#content {
    font-size: 100%;
    margin: 0;
    padding: 20px;
    overflow-y: auto;
    resize: none;
    width: 100%;
    height: 100%;
    min-height: 100%;
    -webkit-box-sizing: border-box;
    -moz-box-sizing: border-box;
    box-sizing: border-box;
    border: 1px #ddd solid;
    outline: none;
}
#printable {
    display: none;
}

@media (prefers-color-scheme: dark) {
    body {
        background: #383934;
    }
    #content {
        background: #282923;
        color: #f8f8f2;
        border: 0;
    }
}

@media print {
    .container {
        display: none;
    }
    #printable {
        display: block;
        white-space: pre-wrap;
        word-break: break-word;
    }
}
    </style>
</head>
<body>
    <div class="nav">
        <a href="/${id}/plain">Plain</a>
        <a href="/${id}/base64">Base64</a>
        <a href="/${id}/md5">MD5</a>
        <a href="/${id}/mtime">Mtime</a>
        <a href="/${id}/html">Type:HTML</a>
        <a href="/${id}/css">Type:CSS</a>
        <a href="/${id}/js">Type:JS</a>
    </div>
    <div class="container">
        <textarea id="content">${escapeHtml(text)}</textarea>
    </div>
    <pre id="printable"></pre>
    <script>
/*! Minimalist Web Notepad | https://github.com/pereorga/minimalist-web-notepad */

function uploadContent() {

    // If textarea value changes.
    if (content !== textarea.value) {
        var temp = textarea.value;
        var request = new XMLHttpRequest();

        request.open('POST', window.location.href, true);
        request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        request.onload = function() {
            if (request.readyState === 4) {

                // Request has ended, check again after 1 second.
                content = temp;
                setTimeout(uploadContent, 1000);
            }
        }
        request.onerror = function() {

            // Try again after 1 second.
            setTimeout(uploadContent, 1000);
        }
        request.send('text=' + encodeURIComponent(temp));

        // Make the content available to print.
        printable.removeChild(printable.firstChild);
        printable.appendChild(document.createTextNode(temp));
    }
    else {

        // Content has not changed, check again after 1 second.
        setTimeout(uploadContent, 1000);
    }
}

var textarea = document.getElementById('content');
var printable = document.getElementById('printable');
var content = textarea.value;

// Make the content available to print.
printable.appendChild(document.createTextNode(content));

textarea.focus();
uploadContent();
    </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return redirect('/' + randomNoteId());
    }

    const id = segments[0];
    const pathMode = segments[1] ?? '';
    if (
      segments.length > 2 ||
      !NOTE_ID_RE.test(id) ||
      (segments.length === 2 && !MODE_RE.test(pathMode))
    ) {
      return notFound();
    }

    const mode = pathMode || url.searchParams.get('mode') || '';

    if (request.method === 'POST') return handlePost(request, env, id, mode);
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound();

    return handleGet(request, env, ctx, id, mode);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(gcExpired(env));
  },
};
