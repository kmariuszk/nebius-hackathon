// Renders search-rerank-30s.html to a 1080p, 30 fps MP4 and writes the matching .srt.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node docs/video/render.mjs
//
// Optional: CHROME=/path/to/chrome-headless-shell when Playwright's own browser
// isn't installed. Needs ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const here = dirname(fileURLToPath(import.meta.url));
const name = 'search-rerank-30s';
const FPS = 30, LENGTH = 30;

const frames = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'frames-'));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
await page.goto(`file://${join(here, name + '.html')}?capture`);
const film = await page.$('#film');
for (let i = 0; i < FPS * LENGTH; i++) {
  await page.evaluate(t => window.render(t), i / FPS);
  await film.screenshot({ path: join(frames, `f${String(i).padStart(4, '0')}.png`) });
}

const stamp = s => {
  const ms = Math.round(s * 1000), pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};
const subs = await page.evaluate(() => window.SUBS);
writeFileSync(join(here, name + '.srt'), subs.map(([a, b, text], k) => `${k + 1}\n${stamp(a)} --> ${stamp(b)}\n${text}\n`).join('\n'));
await browser.close();

execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%04d.png'),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', join(here, name + '.mp4')]);
rmSync(frames, { recursive: true });
console.log(`wrote ${name}.mp4 and ${name}.srt`);
