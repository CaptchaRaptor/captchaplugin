# WS Addon — Remote Control Mode

This addon enables WebSocket-based remote control of the captcha solver. It is designed to be overlaid on top of the base extension from the `extension/` folder.

When using this addon, the extension acts as a personal captcha solving service — on your own resources, without paying for third-party services. The extension connects to the CaptchaPlugin server and waits for incoming tasks. When a task is received, it opens a tab, solves the captcha, and returns the token. One extension instance works in a single thread, but you can connect any number of browsers simultaneously.

Tasks are submitted using the standard 2captcha or AntiCaptcha API format. Full API description: https://captchaplugin.com/api.php

## Requirements

- Chrome 116+ or Firefox 128+
- An API key from https://captchaplugin.com/keys.php

## Getting an API key

1. Register at https://captchaplugin.com/
2. Go to https://captchaplugin.com/keys.php and generate a key
3. Paste the key into the **Anti-Captcha service** block of the extension popup, then turn the service on

## Installation

The easiest way: install `captchaplugin-chrome-ws-*.zip` or `captchaplugin-firefox-ws-*.xpi` from
[Releases](https://github.com/CaptchaRaptor/captchaplugin/releases), paste your API key in the **Anti-Captcha service**
block of the popup and turn the service on.

To build the Chrome version yourself from this repository:

1. Copy all files from this folder **on top of** the `extension/` directory:
   ```
   ws/background_ws.js         → extension/ws/background_ws.js
   ws/offscreen.html           → extension/ws/offscreen.html
   ws/offscreen.js             → extension/ws/offscreen.js
   ws/recaptcha_frame_watch.js → extension/ws/recaptcha_frame_watch.js
   manifest.json               → extension/manifest.json
   ```
2. Load `extension/` in `chrome://extensions` (**Developer mode** → **Load unpacked**), or reload it if it is already loaded.
3. Paste your API key in the **Anti-Captcha service** block of the popup and turn the service on.

## What changes

Compared to the base extension, this addon:

- Replaces the WS stub (`ws/background_ws.js`) with the full WebSocket implementation
- Updates `manifest.json` to add the required permissions: `tabs`, `debugger`, `offscreen`
- Raises the minimum Chrome version from 111 to 116

## How it works

When the Anti-Captcha service (WS mode) is enabled, the background script opens an offscreen document (`ws/offscreen.html`) that maintains a persistent WebSocket connection to the CaptchaPlugin server. When a solve task arrives, the Chrome Debugger API is used to open a controlled tab, intercept the reCAPTCHA network requests, inject the challenge page, and return the solved token.

## Firefox

Firefox has no offscreen documents and no Debugger API, so the Firefox version (`firefox/ws/`) keeps the connection in a
pinned **Anti-Captcha service** tab: keep it open while the service is on, closing it turns the service off.
