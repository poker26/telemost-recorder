#!/usr/bin/env node
/**
 * recorder.js — Puppeteer-бот, который подключается к конференции Телемост
 * и записывает аудио через puppeteer-stream.
 *
 * Использование:
 *   node recorder.js <join_url> <output_file>
 *
 * Остановка:
 *   Отправить SIGTERM — бот корректно завершит запись.
 *
 * Требования:
 *   apt install xvfb
 *   npm install puppeteer-stream xvfb
 */

import { launch, getStream } from "puppeteer-stream";
import { createWriteStream, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import Xvfb from "xvfb";

const joinUrl = process.argv[2];
const outputFile = process.argv[3];

if (!joinUrl || !outputFile) {
  console.error("Использование: node recorder.js <join_url> <output_file>");
  process.exit(1);
}

const outputPath = resolve(outputFile);
console.error(`[recorder] join_url: ${joinUrl}`);
console.error(`[recorder] output:   ${outputPath}`);

function findPuppeteerChrome() {
  const cacheDir = join(homedir(), ".cache", "puppeteer", "chrome");
  if (!existsSync(cacheDir)) return undefined;
  const versions = readdirSync(cacheDir).sort().reverse();
  for (const version of versions) {
    const candidate = join(cacheDir, version, "chrome-linux64", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executablePath = findPuppeteerChrome();
if (!executablePath) {
  console.error("[recorder] Chrome не найден. Запустите: npx puppeteer browsers install chrome");
  process.exit(1);
}
console.error(`[recorder] Chrome: ${executablePath}`);

const xvfb = new Xvfb({
  silent: true,
  xvfb_args: ["-screen", "0", "1280x720x24", "-ac"],
});

xvfb.start((err) => {
  if (err) {
    console.error("[recorder] Xvfb не запустился:", err.message);
    process.exit(1);
  }
});

console.error(`[recorder] Xvfb display: ${xvfb._display}`);

process.env.DISPLAY = xvfb._display;

const fileStream = createWriteStream(outputPath);

const browser = await launch({
  headless: false,
  executablePath,
  defaultViewport: null,
  ignoreDefaultArgs: ["--mute-audio"],
  env: {
    ...process.env,
    DISPLAY: xvfb._display,
  },
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--disable-gpu",
    "--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli",
    "--window-size=1280,720",
    `--display=${xvfb._display}`,
  ],
});

const page = await browser.newPage();

await page.setUserAgent(
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36"
);

await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 30000 });

console.error("[recorder] Страница загружена, ожидаем 5 сек для инициализации...");
await new Promise((r) => setTimeout(r, 5000));

const audioStream = await getStream(page, {
  audio: true,
  video: true,
  mimeType: "video/webm",
});

audioStream.pipe(fileStream);
console.error("[recorder] Запись аудио начата");

let stopping = false;

async function stopRecording() {
  if (stopping) return;
  stopping = true;

  console.error("[recorder] Останавливаем запись...");

  try { audioStream.destroy(); } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  try { fileStream.end(); } catch {}
  try { await browser.close(); } catch {}
  try { xvfb.stop(); } catch {}

  console.error(`[recorder] Запись сохранена: ${outputPath}`);
  process.exit(0);
}

process.on("SIGINT", stopRecording);
process.on("SIGTERM", stopRecording);
