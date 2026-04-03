#!/usr/bin/env node
/**
 * recorder.js — Puppeteer-бот для записи аудио из конференции Телемост.
 *
 * Подход: перехват WebRTC-аудиопотоков через monkey-patch RTCPeerConnection,
 * запись через MediaRecorder в браузере, передача чанков в Node.js.
 * Не требует системных аудиоустройств и tabCapture.
 *
 * Использование:
 *   node recorder.js <join_url> <output_file>
 *
 * Остановка:
 *   Отправить SIGTERM — бот корректно завершит запись.
 */

import puppeteer from "puppeteer";
import { writeFileSync, appendFileSync, existsSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
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

// ── Chrome discovery ─────────────────────────────────────────────────────────

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

// ── Xvfb setup ───────────────────────────────────────────────────────────────

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

// ── Write empty file so stop_meeting.sh sees it ──────────────────────────────

writeFileSync(outputPath, "");

// ── Browser launch ───────────────────────────────────────────────────────────

const browser = await puppeteer.launch({
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
    "--use-fake-device-for-media-stream",
    "--disable-gpu",
    "--window-size=1280,720",
    `--display=${xvfb._display}`,
  ],
});

const page = await browser.newPage();

await page.setUserAgent(
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36"
);

// Expose function to receive audio chunks from the browser
await page.exposeFunction("__saveAudioChunk", (base64data) => {
  const buffer = Buffer.from(base64data, "base64");
  appendFileSync(outputPath, buffer);
});

// Inject WebRTC audio interceptor BEFORE page loads
await page.evaluateOnNewDocument(() => {
  const originalRTCPeerConnection = window.RTCPeerConnection;
  const allRemoteTracks = [];
  let recorderStarted = false;

  window.RTCPeerConnection = function (...args) {
    const peerConnection = new originalRTCPeerConnection(...args);

    peerConnection.addEventListener("track", (event) => {
      if (event.track.kind === "audio") {
        console.log("[recorder-inject] Получен аудио-трек:", event.track.id);
        allRemoteTracks.push(event.track);
        tryStartRecorder();
      }
    });

    return peerConnection;
  };

  window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
  Object.keys(originalRTCPeerConnection).forEach((key) => {
    window.RTCPeerConnection[key] = originalRTCPeerConnection[key];
  });

  function tryStartRecorder() {
    if (recorderStarted || allRemoteTracks.length === 0) return;
    recorderStarted = true;

    console.log("[recorder-inject] Запуск MediaRecorder для", allRemoteTracks.length, "треков");

    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();

    for (const track of allRemoteTracks) {
      const stream = new MediaStream([track]);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
    }

    const recorder = new MediaRecorder(destination.stream, {
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: 32000,
    });

    recorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        const arrayBuffer = await event.data.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        window.__saveAudioChunk(base64);
      }
    };

    recorder.start(2000);
    console.log("[recorder-inject] MediaRecorder запущен (chunk каждые 2 сек)");

    window.__stopRecorder = () => {
      recorder.stop();
      audioContext.close();
      console.log("[recorder-inject] MediaRecorder остановлен");
    };

    // Re-attach new tracks that arrive later
    const origAddTrack = allRemoteTracks.push.bind(allRemoteTracks);
    window.__addRemoteTrack = (track) => {
      origAddTrack(track);
      const stream = new MediaStream([track]);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
      console.log("[recorder-inject] Добавлен новый аудио-трек:", track.id);
    };
  }

  // Watch for late-arriving tracks
  const origAddEventListener = originalRTCPeerConnection.prototype.addEventListener;
  // Already handled in constructor wrapper above
});

// ── Navigate and join conference ─────────────────────────────────────────────

await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 30000 });
console.error("[recorder] Страница загружена");

await new Promise((r) => setTimeout(r, 3000));

const BOT_NAME = process.env.BOT_DISPLAY_NAME || "Бот-записи";

const nameInput = await page.$('input[placeholder*="имя"], input[name*="name"], input[type="text"]');
if (nameInput) {
  await nameInput.click({ clickCount: 3 });
  await nameInput.type(BOT_NAME);
  console.error(`[recorder] Имя бота: ${BOT_NAME}`);
}

const joinButton = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll("button, [role='button']")];
  return buttons.find((b) => /подключиться|присоединиться|join/i.test(b.textContent));
});

if (joinButton && joinButton.asElement()) {
  await joinButton.asElement().click();
  console.error("[recorder] Нажата кнопка Подключиться");
} else {
  console.error("[recorder] WARN: Кнопка Подключиться не найдена");
}

console.error("[recorder] Ожидаем подключение и WebRTC-треки (15 сек)...");
await new Promise((r) => setTimeout(r, 15000));

console.error("[recorder] Запись активна. Ожидаем SIGTERM для остановки...");

// ── Graceful stop ────────────────────────────────────────────────────────────

let stopping = false;

async function stopRecording() {
  if (stopping) return;
  stopping = true;

  console.error("[recorder] Останавливаем запись...");

  try {
    await page.evaluate(() => {
      if (window.__stopRecorder) window.__stopRecorder();
    });
  } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  try { await browser.close(); } catch {}
  try { xvfb.stop(); } catch {}

  console.error(`[recorder] Запись сохранена: ${outputPath}`);
  process.exit(0);
}

process.on("SIGINT", stopRecording);
process.on("SIGTERM", stopRecording);
