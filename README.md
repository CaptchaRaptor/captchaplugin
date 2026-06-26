# Free AI ReCaptcha Solver by Raptor

A browser extension that automatically solves reCAPTCHA image challenges using a built-in ONNX neural network. Completely free — no API key or registration required.

## Features

- Solves 3×3 and 4×4 reCAPTCHA image challenges locally using on-device AI models
- Auto-opens the reCAPTCHA checkbox and starts solving without user interaction
- Configurable solve delay (default 2 s) to avoid triggering bot detection
- Perceptual hash cache — a bundled SQLite database of known image hashes with verified answers is checked before running inference, improving both speed and accuracy

## Installation

### Base extension (Chrome 111+)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

### WS addon (Chrome 116+)

The WS addon enables WebSocket-based remote control for automated pipelines. It is installed on top of the base extension.

See [`ws-addon/README.md`](ws-addon/README.md) for installation instructions.

## Configuration

Click the extension icon to open the popup. Available settings:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | On | Master on/off switch |
| Auto-open | On | Automatically click the reCAPTCHA checkbox |
| Auto-solve | On | Automatically solve the image challenge |
| Solve delay | On, 2 s | Wait before submitting answers (reduces detection risk) |
| Disabled sites | — | Hostnames where the extension is inactive |

## How It Works

1. Content scripts injected into reCAPTCHA frames intercept the challenge UI.
2. Each challenge image is perceptually hashed and looked up in the bundled SQLite cache (`db/captcha.sqlite`). Cache hits return the verified answer without running inference.
3. On a cache miss, the images are passed to two ONNX models running entirely in the browser: `models/type.onnx` determines whether each tile contains the target object (3×3 challenges); `models/grid.onnx` scores each tile position for the correct selection (4×4 challenges).
4. Matching tiles are clicked via the MAIN-world content script that wraps the page's `addEventListener`.
5. All encountered images and their answers are saved to IndexedDB and periodically uploaded to `captcharaptor.com` to expand the training dataset for future model improvements.

## Data Collection

The extension collects anonymized captcha solve data (challenge images, selected tiles, solve outcome) and periodically uploads it to `captcharaptor.com`. This data is used to improve the AI models.

- A random 16-character reporting key is generated per browser profile and stored locally. It is not linked to any account.
- Uploads can be disabled in the **Reports** section of the extension popup.
- No personally identifiable information is collected.

## License

MIT — see [LICENSE](LICENSE)
