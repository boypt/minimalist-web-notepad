Minimalist Web Notepad — Developers Mod
========================================

A single-page PHP notepad. Forked from
[pereorga/minimalist-web-notepad](https://github.com/pereorga/minimalist-web-notepad)
to add a few features useful to developers.

What this fork adds
-------------------

- **CLI POST path.** `curl --data-binary @-` to `/<id>` writes the raw
  request body to the note, no form field required.
- **Append mode.** `curl --data-binary @-` to `/<id>/append` appends
  instead of overwriting.
- **Output mode routing.** Append `/{mode}` to a note URL to get the
  stored content in a specific format:
  - `plain` — `text/plain`, raw text
  - `base64` — `text/plain`, base64-encoded
  - `md5` — `text/plain`, MD5 hash
  - `mtime` — `text/plain`, last-modified timestamp
  - `html` / `css` / `js` / `json` — same content with the matching
    `Content-Type` header, so the note can be embedded as a web source
- **curl auto-raw.** Any request with a `curl` user-agent gets the raw
  stored content with no HTML wrapper, even without a `mode` query.

The 1-second autosave in the web UI is unchanged from upstream.

Quick examples
--------------

```
# Upload a file's contents from the CLI
dmesg | curl --data-binary @- https://example.com/dmesg

# Append more output
dmesg | tail -100 | curl --data-binary @- https://example.com/dmesg/append

# Read it back (curl UA → auto-raw, no /plain needed)
curl https://example.com/dmesg

# Or be explicit
curl https://example.com/dmesg/plain
curl https://example.com/dmesg/base64
curl https://example.com/dmesg/md5
curl https://example.com/dmesg/mtime

# Embed the note as a CSS file (Content-Type: text/css)
<link rel="stylesheet" href="https://example.com/site.css/css">
```

Note IDs are 5 chars drawn from `234579abcdefghjkmnpqrstwxyz` (no
ambiguous characters).

Installation
------------

This app is served from the site root. Redirects and the favicon use
absolute paths (`/<id>`, `/favicon.ico`). For subpath deployments, front
it with a reverse proxy that rewrites the path, or add a `<base href>`
shim to the HTML.

The web server must be able to **write to the `_tmp` directory** — that
is the only persistence layer.

PHP 7.4+ is fine. The whole app is a single `index.php`; CSS and JS are
inlined into it.

### Apache

Enable `mod_rewrite` and let `.htaccess` take effect. The shipped
`.htaccess` rewrites `^/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$` to
`index.php?note=$1&mode=$2` and disables directory indexes.

For basic auth, uncomment the bottom block of `.htaccess` and point
`AuthUserFile` at your `htpasswd` file.

### Nginx

If the project is in the document root:

```
location / {
    rewrite ^/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$ /index.php?note=$1&mode=$2 last;
}
```

If it lives in a subdirectory:

```
location ~* ^/notes/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$ {
    try_files $uri /notes/index.php?note=$1&mode=$2;
}
```

### Caddy2

```
https://example.com {

    root * /srv/notepad
    encode gzip zstd

    file_server {
        hide /_tmp
    }

    @npath {
        path_regexp note ^/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$
    }

    rewrite @npath /index.php?note={http.regexp.note.1}&mode={http.regexp.note.2}&{query}
    php_fastcgi 127.0.0.1:9000
}
```

`hide /_tmp` is important — without it, stored notes are served as
static files (the upstream Apache config uses `_tmp/.htaccess` to
deny HTTP access, but Caddy has no equivalent of that file).

License
-------

Copyright 2012 Pere Orga <pere@orga.cat>

Licensed under the Apache License, Version 2.0. See the header of
`index.php` and <http://www.apache.org/licenses/LICENSE-2.0> for the
full text.
