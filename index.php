<?php

// Disable caching.
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

// If a note's name is not provided or contains invalid characters.
if (!isset($_REQUEST['note']) || !preg_match('/^[a-zA-Z0-9_-]+$/', $_REQUEST['note'])) {

    // Generate a name with 5 random unambiguous characters. Redirect to it.
    header("Location: /" . substr(str_shuffle('234579abcdefghjkmnpqrstwxyz'), -5));
    die;
}

$path = '_tmp/' . $_REQUEST['note'];

// write to server
if ($_SERVER['REQUEST_METHOD'] === "POST") {

    // Web action
    if (isset($_POST['text'])) {

        // Update file.
        file_put_contents($path, $_POST['text'], LOCK_EX);

        // If provided input is empty, delete file.
        if (!strlen($_POST['text'])) {
            unlink($path);
        }

    // CLI action (eg. from curl)
    } else {
        $filemode = LOCK_EX;
        if (isset($_REQUEST["mode"]) && $_REQUEST["mode"] === "append") {
            $filemode |= FILE_APPEND;
        }
        file_put_contents($path, file_get_contents("php://input"), $filemode);
    }
    die;
}

// text mode output
if (is_file($path) && isset($_GET["mode"]) && $_GET["mode"] != "") {
    switch($_GET["mode"]) {
        case "base64":
            header('Content-type: text/plain');
            print base64_encode(file_get_contents($path));
            break;
        case "plain":
            header('Content-type: text/plain');
            print file_get_contents($path);
            break;
        case "md5":
            header('Content-type: text/plain');
            print hash_file('md5', $path);
            break;
        case "mtime":
            header('Content-type: text/plain');
            print filemtime($path);
            break;
        case "html":
            header('Content-type: text/html');
            print file_get_contents($path);
            break;
        case "css":
            header('Content-type: text/css');
            print file_get_contents($path);
            break;
        case "js":
            header('Content-type: text/javascript');
            print file_get_contents($path);
            break;
        case "json":
            header('Content-type: application/json');
            print file_get_contents($path);
            break;
        default:
            print file_get_contents($path);
            break;
    }
    die;
}

if (!is_file($path) && isset($_GET["mode"]) && $_GET["mode"] != "") {
    header("Location: /" . $_REQUEST['note']);
    die;
}

// Output raw file if client is curl.
if (strpos($_SERVER['HTTP_USER_AGENT'], 'curl') === 0) {
    if (is_file($path)) {
        print file_get_contents($path);
    }
    die;
}
?><!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="generator" content="Minimalist Web Notepad Developers Mod">
    <title><?php print $_GET['note']; ?></title>
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
        <a href="<?php print $_GET['note']; ?>/plain">Plain</a>
        <a href="<?php print $_GET['note']; ?>/base64">Base64</a>
        <a href="<?php print $_GET['note']; ?>/md5">MD5</a>
        <a href="<?php print $_GET['note']; ?>/mtime">Mtime</a>
        <a href="<?php print $_GET['note']; ?>/html">Type:HTML</a>
        <a href="<?php print $_GET['note']; ?>/css">Type:CSS</a>
        <a href="<?php print $_GET['note']; ?>/js">Type:JS</a>
    </div>
    <div class="container">
        <textarea id="content"><?php
            if (is_file($path)) {
                print htmlspecialchars(file_get_contents($path), ENT_QUOTES, 'UTF-8');
            }
        ?></textarea>
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
</html>
