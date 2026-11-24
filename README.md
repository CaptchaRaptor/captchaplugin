# Free AI ReCaptcha Solver by Raptor

A browser extension that automatically solves reCAPTCHA image challenges using a built-in ONNX neural network. Completely free — no API key or registration required.

## Features

- Solves 3×3 and 4×4 reCAPTCHA image challenges locally using on-device AI models
- Auto-opens the reCAPTCHA checkbox and starts solving without user interaction
- Configurable solve delay (default 2 s) to avoid triggering bot detection
- Perceptual hash cache — a bundled SQLite database of known image hashes with verified answers is checked before running inference, improving both speed and accuracy

## Installation

Ready packages are on the [Releases](https://github.com/CaptchaRaptor/captchaplugin/releases) page.

### Chrome (111+)

1. Download `captchaplugin-chrome-*.zip` (or `captchaplugin-chrome-ws-*.zip` with the Anti-Captcha service, Chrome 116+) and unzip it
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the unzipped folder

You can also load the `extension/` folder of this repository the same way.

### Firefox (128+)

Download `captchaplugin-firefox-*.xpi` (or `captchaplugin-firefox-ws-*.xpi` with the Anti-Captcha service),
open it in Firefox and confirm the installation.

### Anti-Captcha service

The `-ws` packages can work as your own captcha solving service: tasks are sent in the 2Captcha / Anti-Captcha API
format, the extension solves them in your browser and returns the token. See [`ws-addon/README.md`](ws-addon/README.md).

### Build from source

`node build.js` (Node.js 18+, no dependencies) builds all four packages into `dist/`: `chrome`, `chrome-ws`, `firefox`,
`firefox-ws`. These builds are unsigned: Firefox loads them only temporarily (`about:debugging` → **This Firefox** →
**Load Temporary Add-on…**), use the signed `.xpi` from Releases for a permanent installation.

## Support

Questions and bug reports: [Discord](https://discord.gg/mQBHTVjPb).

## Configuration

Click the extension icon to open the popup. Available settings:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Master on/off switch |
| Auto-open | On | Automatically click the reCAPTCHA checkbox |
| Auto-solve | On | Automatically solve the image challenge |
| Between tile clicks | 300 ms | Pause between clicking individual tiles (3×3 only) |
| Dynamic reveal → click | 850 ms | Pause from a new dynamic tile image appearing to clicking it (counts recognition time already spent) |
| Last click → verify | 850 ms | Pause between the final tile click and pressing Verify |
| Disabled sites | — | Hostnames where the extension is inactive |
| Anti-Captcha service | Off | Use the extension as a service like Anti-Captcha or 2Captcha to solve reCAPTCHA for free in your software. Works only in the version with the [WS add-on](ws-addon/README.md); requires a 32-character API key entered next to the switch |

A random 0–300 ms jitter is added to each timeout above every time it fires. Tiles in a 3×3 challenge are clicked in a randomized order.

## How It Works

1. Content scripts injected into reCAPTCHA frames intercept the challenge UI.
2. Each challenge image is perceptually hashed and looked up in the bundled SQLite cache (`db/captcha.sqlite`). Cache hits return the verified answer without running inference.
3. On a cache miss, the images are passed to two ONNX models running entirely in the browser: `models/type.onnx` determines whether each tile contains the target object (3×3 challenges); `models/grid.onnx` scores each tile position for the correct selection (4×4 challenges).
4. Matching tiles are clicked via the MAIN-world content script that wraps the page's `addEventListener`.
5. All encountered images and their answers are saved to IndexedDB and periodically uploaded to `captcharaptor.com` to expand the training dataset for future model improvements.

## Data Collection

The extension collects anonymized captcha solve data (challenge images, selected tiles, solve outcome) and periodically uploads it to `captcharaptor.com`. This data is used to improve the AI models.

- A random 16-character reporting key is generated per browser profile and stored locally. It is not linked to any account and is not shown in the popup.
- Uploads can be disabled in the **Reports** section of the extension popup.
- No personally identifiable information is collected.

## License

MIT — see [LICENSE](LICENSE)
