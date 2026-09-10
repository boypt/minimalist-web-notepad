# Minimalist Web Notepad — Cloudflare Workers + D1

A port of the single-file PHP app in the repository root (`index.php`) to a
[Cloudflare Worker](https://developers.cloudflare.com/workers/) backed by
[D1](https://developers.cloudflare.com/d1/). Same URLs, same output modes,
same 1-second autosave UI — but serverless and durable.

## What changed vs. the PHP version

| Concern | PHP app | Worker app |
| --- | --- | --- |
| Storage | flat files in `_tmp/` | D1 table `notes` |
| Body storage | raw bytes on disk | **zstd-compressed BLOB** |
| Expiry / GC | none | `expires_at` column + daily Cron Trigger |
| Password | none | reserved `password_*` columns (not enforced yet) |
| Routing | `.htaccess` rewrite | Worker `fetch` handler |

## Layout

```
worker/
├── src/index.js              # Worker: router, D1 store, compression, modes
├── migrations/0001_init.sql  # D1 schema
├── public/favicon.ico        # served as a static asset
├── wrangler.toml             # bindings, cron, vars
└── package.json              # wrangler dev/deploy scripts
```

## Behaviour (identical to the PHP app)

- `GET /` → `302` to a random 5-char note id (`234579abcdefghjkmnpqrstwxyz`).
- `GET /:note` → HTML editor; autosaves via `POST` every 1s.
- `GET /:note/:mode` → stored note in that mode:
  `plain`, `base64`, `md5`, `mtime`, `html`, `css`, `js`, `json`.
  Unknown modes and `mtime` fall back / report as before.
- `POST /:note` with a `text` form field → save (empty `text` **deletes**).
- `POST /:note` with a raw body → CLI save.
- `POST /:note/append` with a raw body → CLI append.
- Any `curl` user-agent → raw stored body, no HTML wrapper.
- All responses are `no-store` and `X-Robots-Tag: noindex, nofollow`.

## Compression

Every note body is zstd-compressed via `node:zlib` and stored as a BLOB.
`content_encoding` records the codec (`zstd`), and `size_raw` / `size_stored`
record both sizes for visibility. Reads transparently decompress; `gzip` and
`identity` are also understood so data written by an earlier build stays
readable.

Why `node:zlib` instead of the Web `CompressionStream` API? The Web API only
implements `gzip` / `deflate` / `deflate-raw` in Workers — `zstd` (and
`brotli`) are unavailable there. `node:zlib` provides zstd, which requires
the `nodejs_compat` compatibility flag already set in `wrangler.toml`.

## Expiry and garbage collection

- On every write, `expires_at = now + NOTE_TTL_DAYS` (default `30`, set
  `NOTE_TTL_DAYS = "0"` to disable). `created_at` is set once, `updated_at`
  on every write.
- A Cron Trigger (`0 3 * * *`) runs the `scheduled` handler, which deletes
  rows whose `expires_at` is in the past.
- Reads also lazily delete an expired row via `ctx.waitUntil`.

## Reserved password structure

The schema already carries `is_protected`, `password_hash`, `password_salt`
and `password_algo`. The current Worker always writes `is_protected = 0` and
does not enforce anything. A future change can add the hash check (suggested:
PBKDF2 via `crypto.subtle.deriveBits`, storing `password_algo =
"pbkdf2-sha256"`).

## Setup

> Full production deployment guide: [DEPLOY.md](./DEPLOY.md).

```sh
cd worker
npm install

# 1. Create the D1 database and copy the printed database_id into wrangler.toml
npx wrangler d1 create minimalist-web-notepad

# 2. Apply the schema (use --local for local dev)
npx wrangler d1 migrations apply minimalist-web-notepad --remote

# 3. Run locally or deploy
npx wrangler dev
npx wrangler deploy
```

Manual smoke test (mirrors the PHP checklist):

```sh
curl -s https://<your-worker>/cli-test/plain          # empty
echo hello | curl --data-binary @- https://<your-worker>/cli-test
curl https://<your-worker>/cli-test                    # hello (curl UA → raw)
curl https://<your-worker>/cli-test/md5                # 5d41402a...
echo " world" | curl --data-binary @- https://<your-worker>/cli-test/append
curl https://<your-worker>/cli-test                    # hello world
```

## Scope note

`package.json`, `wrangler.toml` and `migrations/` are new files required by
the Cloudflare Workers toolchain. The PHP app in the repository root is
untouched and still runs as before.
