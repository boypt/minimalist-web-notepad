Minimalist Web Notepad Developers Mod
======================

This mod adds few features useful to developers.

 * multiple output modes: plain/base64/md5/mtime
 * multiple output mime: html/js/css/json (embed as web source)
 * post content from cli (with append mode)

Example: 
```
# upload data from cli
dmesg | curl --data-binary @- http://mininopad.url/dmesg

# append data from cli
dmesg | curl --data-binary @- http://mininopad.url/dmesg/append

# get plain text (curl user-agent)
curl http://mininopad.url/dmesg

# base64 encoded text
curl http://mininopad.url/dmesg/base64

# md5 hash of the text
curl http://mininopad.url/dmesg/md5

# view as html
curl http://mininopad.url/dmesg/html
``` 

Installation
------------

This app assumes it is served at the site root (redirects and the favicon
use absolute paths like `/<id>` and `/favicon.ico`). For subpath deployments,
front it with a reverse proxy that rewrites the path or add a `<base href>` shim.

Make sure the web server is allowed to write to the `_tmp` directory.

### On Apache

You may need to enable mod_rewrite and set up `.htaccess` files in your site configuration.
See [How To Set Up mod_rewrite for Apache](https://www.digitalocean.com/community/tutorials/how-to-set-up-mod_rewrite-for-apache-on-ubuntu-14-04).

### On Nginx

To enable URL rewriting, put something like this in your configuration file:

If notepad is in the root directory:
```
location / {
    rewrite ^/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$ /index.php?note=$1&mode=$2?;
}
```

If notepad is in a subdirectory:
```
location ~* ^/notes/([a-zA-Z0-9_-]+)/?([a-z0-9]*)?$ {
    try_files $uri /notes/index.php?note=$1&mode=$2?;
}
```

### On Caddy2

```
https://mydomian.com {

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

Screenshots
-----------
![preview](https://user-images.githubusercontent.com/1033514/70497456-35121d00-1b4e-11ea-8ffe-e70d57169726.png)

Copyright and license
---------------------

Copyright 2012 Pere Orga <pere@orga.cat>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this work except in compliance with the License.
You may obtain a copy of the License at:

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
