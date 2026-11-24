#!/usr/bin/env node
// Builds the extension packages from extension/ and ws-addon/ (unsigned).
// No dependencies: Node.js 18+ only.
//
//   node build.js [target...] [--out dist]
//
// Targets (default: all):
//   chrome       Chrome 111+
//   chrome-ws    Chrome 116+ with the Anti-Captcha service (ws-addon)
//   firefox      Firefox 128+
//   firefox-ws   Firefox 128+ with the Anti-Captcha service (ws-addon/firefox)
//
// Each package is written as <out>/captchaplugin-<target>/ and .zip. Chrome: load the folder
// in chrome://extensions (Developer mode -> Load unpacked). Firefox installs only signed
// add-ons permanently; an unsigned build can be loaded in about:debugging -> This Firefox ->
// Load Temporary Add-on (until the browser restarts). Signed builds are on the Releases page.

'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const EXT = path.join(ROOT, 'extension');
const WS = path.join(ROOT, 'ws-addon');

// ---- Helpers ----
function fail(msg) { console.error('build.js: ' + msg); process.exit(1); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
function removeLine(file, line) {
  const s = fs.readFileSync(file, 'utf8');
  const lines = s.split(/\r?\n/);
  const n = lines.filter(l => l.trim() === line).length;
  if (n !== 1) fail(`${path.relative(ROOT, file)}: expected the line "${line}" once, found ${n}`);
  fs.writeFileSync(file, lines.filter(l => l.trim() !== line).join('\n'));
}
// Set "version"/"version_name" in place, keeping the rest of the file as written.
function setVersionText(file, v) {
  let s = fs.readFileSync(file, 'utf8');
  for (const key of ['version', 'version_name']) {
    const re = new RegExp(`("${key}"\\s*:\\s*")[^"]*(")`);
    if (!re.test(s)) fail(`${file}: no "${key}"`);
    s = s.replace(re, `$1${v}$2`);
  }
  fs.writeFileSync(file, s);
}


// ---- Chrome ----
function buildChrome(dir, ws, v) {
  if (ws) {
    // ws-addon/README.md: copy ws/ and manifest.json on top of extension/.
    copyDir(path.join(WS, 'ws'), path.join(dir, 'ws'));
    fs.copyFileSync(path.join(WS, 'manifest.json'), path.join(dir, 'manifest.json'));
  }
  setVersionText(path.join(dir, 'manifest.json'), v);
}

// ---- Firefox ----
function buildFirefox(dir, ws, v) {
  // 2-3: background scripts are listed in the manifest instead of importScripts.
  removeLine(path.join(dir, 'background.js'), "importScripts(chrome.runtime.getURL('background_sqlite.js'));");
  removeLine(path.join(dir, 'background.js'), "importScripts(chrome.runtime.getURL('uploader.js'));");
  removeLine(path.join(dir, 'background.js'), "importScripts(chrome.runtime.getURL('ws/background_ws.js'));");
  removeLine(path.join(dir, 'background_sqlite.js'), "importScripts(chrome.runtime.getURL('lib/sql-wasm.js'));");

  // 1: manifest.
  const m = readJson(path.join(dir, 'manifest.json'));
  const out = {};
  for (const [k, val] of Object.entries(m)) {
    if (k === 'minimum_chrome_version') continue;
    out[k] = val;
    if (k === 'manifest_version') {
      out.browser_specific_settings = {
        gecko: {
          id: 'captchaplugin@captcharaptor',
          strict_min_version: '128.0',
          data_collection_permissions: { required: ['none'], optional: ['technicalAndInteraction'] },
        },
      };
    }
  }
  out.name = 'Free AI ReCaptcha Solver by Raptor'; // AMO: at most 45 characters
  out.background = { scripts: ['lib/sql-wasm.js', 'background_sqlite.js', 'background.js', 'uploader.js', 'ws/background_ws.js'] };
  out.host_permissions = ['*://*.google.com/recaptcha/*', '*://*.recaptcha.net/recaptcha/*'];
  out.version = out.version_name = v;

  // 4: WS mode (Firefox implementation in ws-addon/firefox/ws/).
  if (ws) {
    for (const f of ['offscreen.js', 'recaptcha_frame_watch.js']) {
      fs.copyFileSync(path.join(WS, 'ws', f), path.join(dir, 'ws', f));
    }
    copyDir(path.join(WS, 'firefox', 'ws'), path.join(dir, 'ws'));
    const p = out.permissions;
    p.splice(p.indexOf('alarms') + 1, 0, 'scripting', 'proxy');
    p.push('tabs', 'webRequest', 'webRequestBlocking', 'webRequestFilterResponse');
    out.host_permissions.push('<all_urls>');
  }
  writeJson(path.join(dir, 'manifest.json'), out);
}

// ---- Zip (stored or deflated entries, no dependencies) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function listFiles(dir, rel = '') {
  const res = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) res.push(...listFiles(dir, r));
    else if (e.isFile()) res.push(r);
  }
  return res;
}
function zipDir(dir, zipFile) {
  const fd = fs.openSync(zipFile, 'w');
  const central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01: reproducible archives
  for (const name of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, name));
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);              // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    fs.writeSync(fd, local); fs.writeSync(fd, nameBuf); fs.writeSync(fd, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeSync(fd, cenBuf); fs.writeSync(fd, end);
  fs.closeSync(fd);
}

// One package: copy extension/ to dir and turn it into the target. Firefox versions start with 1.
function buildPackage(dir, browser, ws, version) {
  fs.rmSync(dir, { recursive: true, force: true });
  copyDir(EXT, dir);
  if (browser === 'chrome') buildChrome(dir, ws, version);
  else buildFirefox(dir, ws, version);
}
function firefoxVersion(v) { return v.replace(/^\d+/, '1'); }

module.exports = { EXT, WS, fail, readJson, buildPackage, firefoxVersion, zipDir };

// ---- Main ----
if (require.main === module) {
  const TARGETS = {
    'chrome':     { browser: 'chrome',  ws: false },
    'chrome-ws':  { browser: 'chrome',  ws: true },
    'firefox':    { browser: 'firefox', ws: false },
    'firefox-ws': { browser: 'firefox', ws: true },
  };
  const args = process.argv.slice(2);
  let out = path.join(ROOT, 'dist');
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') out = path.resolve(args[++i]);
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else if (args[i] === 'all') targets.push(...Object.keys(TARGETS));
    else if (TARGETS[args[i]]) targets.push(args[i]);
    else fail(`unknown target "${args[i]}" (${Object.keys(TARGETS).join(', ')}, all)`);
  }
  if (!targets.length) targets.push(...Object.keys(TARGETS));
  fs.mkdirSync(out, { recursive: true });
  for (const name of targets) {
    const t = TARGETS[name];
    // Version as in the source manifest (ws-addon/manifest.json for the WS builds).
    const v0 = readJson(path.join(t.ws ? WS : EXT, 'manifest.json')).version;
    const v = t.browser === 'firefox' ? firefoxVersion(v0) : v0;
    const dir = path.join(out, `captchaplugin-${name}`);
    buildPackage(dir, t.browser, t.ws, v);
    fs.rmSync(dir + '.zip', { force: true });
    zipDir(dir, dir + '.zip');
    console.log(`${path.relative(process.cwd(), dir) || dir}.zip  (${v})`);
  }
}
