// 2026-11-12-make-pwa-icons.mjs — one-off generator for the PWA icons (Keel 5.2).
//
// Context: an installable web app needs PNG icons at fixed sizes (192 and 512,
// a "maskable" 512 with the glyph inside the safe zone, and a 180 for iOS).
// The project has no build step and no packages, so the PNGs are generated
// once, here, and committed. The drawing is src/icons/icon.svg; the maskable
// variant (square, no rounded corners, smaller glyph — launchers crop it to
// their own shape) exists only in this script.
//
// How: headless Chrome renders each SVG at 512×512 on a transparent page and
// screenshots it; macOS `sips` scales the smaller sizes down from that.
//
// Use (from the repo root):
//   node scripts/ephemeral/2026-11-12-make-pwa-icons.mjs <scratch-dir>
// Needs Google Chrome and macOS (sips). Re-run it if icon.svg changes.
//
// OUTCOME: see the end of this file.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const scratch = process.argv[2];
if (!scratch) throw new Error('usage: node 2026-11-12-make-pwa-icons.mjs <scratch-dir>');
const work = join(resolve(scratch), 'pwa-icons');
mkdirSync(work, { recursive: true });
const out = resolve('src/icons');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const MASKABLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#1f7a7a"/>
  <path d="M196 170v172M316 170v172M196 256h120" fill="none" stroke="#fff" stroke-width="36" stroke-linecap="round"/>
</svg>`;

// A page that is exactly the drawing: no margin, no scrollbars, no background.
const page = (svg) => `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg}`;

function render(name, svg) {
  const html = join(work, `${name}.html`);
  const png = join(work, `${name}.png`);
  writeFileSync(html, page(svg));
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--user-data-dir=${join(work, 'chrome')}`, '--window-size=512,512', `--screenshot=${png}`, `file://${html}`], { stdio: 'ignore' });
  return png;
}
function scaled(from, size, to) {
  execFileSync('sips', ['-z', String(size), String(size), from, '--out', to], { stdio: 'ignore' });
}

const any512 = render('any', readFileSync(join(out, 'icon.svg'), 'utf8'));
const mask512 = render('maskable', MASKABLE);

copyFileSync(any512, join(out, 'icon-512.png'));
scaled(any512, 192, join(out, 'icon-192.png'));
copyFileSync(mask512, join(out, 'icon-maskable-512.png'));
// iOS rounds the corners itself and shows transparency as black, so it gets the full-bleed drawing.
scaled(mask512, 180, join(out, 'apple-touch-icon.png'));

console.log('wrote icon-512.png, icon-192.png, icon-maskable-512.png, apple-touch-icon.png to', out);

// OUTCOME (2026-11-12): ran once; the four PNGs in src/icons/ are its output
// (512×512 and 192×192 with transparent corners; maskable 512×512 and iOS
// 180×180 full-bleed, no alpha — checked with `sips -g`). tests/pwa.test.js
// now holds the sizes to what the manifest claims. Chrome's installability
// check accepted them (2026-11-12-drive-chat-flow.mjs).
