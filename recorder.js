#!/usr/bin/env node
/**
 * recorder.js — Puppeteer-бот, который подключается к конференции Телемост
 * и записывает аудио через puppeteer-stream.
 *
 * Использование:
 *   node recorder.js <join_url> <output_file>
 *
 * Остановка:
 *   Отправить SIGINT (Ctrl+C) или SIGTERM — бот корректно завершит запись.
 */

import { launch, getStream } from "puppeteer-stream";
import { createWriteStream } from "fs";
import { resolve } from "path";

const joinUrl = process.argv[2];
const outputFile = process.argv[3];

if (!joinUrl || !outputFile) {
  console.error("Использование: node recorder.js <join_url> <output_file>");
  process.exit(1);
}

const outputPath = resolve(outputFile);
console.error(`[recorder] join_url: ${joinUrl}`);
console.error(`[recorder] output:   ${outputPath}`);

const fileStream = createWriteStream(outputPath);

const browser = await launch({
  headless: "new",
  ignoreDefaultArgs: ["--mute-audio"],
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
  ],
});

const page = await browser.newPage();

await page.setUserAgent(
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36"
);

await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 30000 });

console.error("[recorder] Страница загружена, ожидаем 5 сек для инициализации...");
await new Promise((resolve) => setTimeout(resolve, 5000));

const audioStream = await getStream(page, {
  audio: true,
  video: false,
  mimeType: "audio/webm;codecs=opus",
});

audioStream.pipe(fileStream);
console.error("[recorder] Запись аудио начата");

let stopping = false;

async function stopRecording() {
  if (stopping) return;
  stopping = true;

  console.error("[recorder] Останавливаем запись...");

  try {
    audioStream.destroy();
  } catch {}

  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    fileStream.end();
  } catch {}

  try {
    await browser.close();
  } catch {}

  console.error(`[recorder] Запись сохранена: ${outputPath}`);
  process.exit(0);
}

process.on("SIGINT", stopRecording);
process.on("SIGTERM", stopRecording);
