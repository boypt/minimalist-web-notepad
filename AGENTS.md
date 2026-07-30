# AGENTS.md

Minimalist Web Notepad — a single-page PHP notepad. Forked from
[pereorga/minimalist-web-notepad](https://github.com/pereorga/minimalist-web-notepad)
with added output modes and a CLI POST path.

## What this repo is

- One-file PHP app: `index.php` is the only backend code.
- CSS and JS are inlined in `index.php` (light + `prefers-color-scheme: dark` + print rules; autosave every 1s via `XMLHttpRequest`).
- Storage: flat files under `_tmp/<note-id>`. No database.
- Entry point: `index.php` (also fronted by `.htaccess` URL rewrite).

There is no `package.json`, no `composer.json`, no build step, no test
suite, no linter, no formatter, no CI workflow, and no `.gitignore`.
Adding any of those is a scope change — confirm with the user first.

## Files

- `index.php` — router, writer, and HTML template (with inlined CSS + JS) in one file.
- `.htaccess` — Apache rewrite `^/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$` →
  `index.php?note=$1&mode=$2`. Also sets `X-Robots-Tag: noindex,nofollow`
  and disables directory indexes.
- `_tmp/.htaccess` — denies HTTP access to stored notes. Do not delete.
- `favicon.ico` — site icon.

## Runtime / setup gotchas

- Requires PHP (any modern version with `file_put_contents` + `LOCK_EX`).
  `php` was not on PATH in this environment — install it before running.
- Web server must be able to **write to the `_tmp` directory** (this is
  the only persistence layer). On Apache enable `mod_rewrite` so
  `.htaccess` rewrite works.
- If deploying off-root, this app assumes it's served at the site root
  (redirects and favicon use absolute paths like `/<id>` and `/favicon.ico`).
  There is no `$base_url` configuration — for subpath deployments, front
  it with a reverse proxy that rewrites the path or add a `<base href>` shim.
- No `.htaccess` ⇒ no pretty URLs ⇒ request goes through `index.php?note=…`
  directly, which still works because `index.php` reads `$_REQUEST['note']`.

## Routing and HTTP behavior (worth knowing before changing `index.php`)

- Note IDs must match `^[a-zA-Z0-9_-]+$` (enforced in both `.htaccess`
  and `index.php:15`). Random new IDs are 5 chars drawn from
  `234579abcdefghjkmnpqrstwxyz` (no ambiguous chars).
- `GET` with `?mode=<m>` returns the stored note in that mode:
  `plain`, `base64`, `md5`, `mtime`, `html`, `css`, `js`, `json`.
  Unknown modes fall through to raw text.
- `POST` with a `text` form field is the web-save path; empty `text`
  **deletes** the file.
- `POST` without a `text` field reads raw request body (CLI path).
  Append by POSTing to `/<note>/append` — `mode=append` is the flag the
  code checks (`index.php:41`).
- If the `User-Agent` starts with `curl`, the response is the raw file
  with no HTML wrapper — even without a `mode` query param.
- All responses set `Cache-Control: no-cache, no-store, must-revalidate`.

## JS quirks (inlined in `index.php`)

- `content`, `textarea`, `printable` are implicit globals — no `var`
  inside `uploadContent` is intentional, do not "fix" by adding
  `use strict` without re-reading the closures.
- The 1-second loop re-checks whether the textarea changed; if not, it
  just reschedules. No backoff, no offline detection beyond `onerror`.
- `#printable` mirrors the textarea so `window.print()` (CSS
  `@media print` hides the textarea) shows the current text.

## Editing conventions

- Keep changes small and to one file when possible. The point of this
  repo is minimalism.
- If you change routing or note-ID validation, update both `index.php`
  and `.htaccess` (and the Nginx/Caddy snippets in `README.md`).
- If you add a new output mode, also add a link in the `.nav` block in
  `index.php` (~line 114) so it is discoverable from the UI.
- The `<meta name="generator">` tag identifies the fork — preserve it.

## Verifying changes

There is no automated test suite. Manual verification:

1. Run PHP's built-in server for a quick check:
   `php -S 127.0.0.1:8000` from the repo root.
2. Open `http://127.0.0.1:8000/` — you should be redirected to a random
   5-char note URL.
3. Type something, wait ~1s, refresh — content should persist.
4. Try `curl http://127.0.0.1:8000/<id>/plain` and `…/base64` and
   `…/md5` — should return the stored text, base64, and md5.
5. `echo hello | curl --data-binary @- http://127.0.0.1:8000/cli-test`
   then `…/cli-test/plain` should print `hello`.
6. Append: `echo world | curl --data-binary @- http://127.0.0.1:8000/cli-test/append`.
7. Clear the textarea, wait for autosave — file should be deleted from
   `_tmp/`.

## Things deliberately omitted

- No framework, no Composer, no npm. Don't add them without asking.
- No tests. Don't add a test runner without asking.
- No CI. Don't add GitHub Actions without asking.
- No `.gitignore` — note files in `_tmp/` are server runtime data, not
  source; if you create one, exclude `_tmp/*` but keep
  `_tmp/.htaccess` (use `!_tmp/.htaccess`).
