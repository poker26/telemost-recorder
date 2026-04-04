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
 *   Отправить SIGTERM — бот корректно завершит запись (state оставляет stop_meeting.sh).
 *
 * Автоостановка после завершения встречи организатором (без /meeting_stop):
 *   Основной признак (см. probe_meeting_ui.js / лог): переход с /j/<id> на главную pathname «/»,
 *   на экране появляется data-testid="create-call-button".
 *   Дополнительно: TELEMOST_END_TEXT_MARKERS — подстроки в тексте страницы (по умолчанию выключено).
 *   Финализация: удаление state, опционально POST TELEMOST_FINISH_WEBHOOK_URL.
 */

import puppeteer from "puppeteer";
import {
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  statSync,
} from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import Xvfb from "xvfb";

const STATE_FILE = "/tmp/telemost_meeting.json";

const joinUrl = process.argv[2];
const outputFile = process.argv[3];

if (!joinUrl || !outputFile) {
  console.error("Использование: node recorder.js <join_url> <output_file>");
  process.exit(1);
}

let joinMeetingPathname = "";
try {
  joinMeetingPathname = new URL(joinUrl).pathname;
} catch {
  console.error("[recorder] Некорректный join_url");
  process.exit(1);
}
if (!joinMeetingPathname.startsWith("/j/")) {
  console.error(
    "[recorder] Ожидается ссылка вида https://telemost.yandex.ru/j/<id> для детекта окончания встречи",
  );
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

async function muteMicAndCamera() {
  const result = await page.evaluate(() => {
    let micDone = false;
    let camDone = false;

    const micBtn = document.querySelector('[data-testid="turn-off-mic-button"]');
    if (micBtn) { micBtn.click(); micDone = true; }

    const camBtn = document.querySelector('[data-testid="turn-off-camera-button"]');
    if (camBtn) { camBtn.click(); camDone = true; }

    return { micDone, camDone };
  });
  return result;
}

const muteResult = await muteMicAndCamera();
console.error(`[recorder] Mute на лобби: mic=${muteResult.micDone}, cam=${muteResult.camDone}`);

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

const muteResult2 = await muteMicAndCamera();
console.error(`[recorder] Mute в конференции: mic=${muteResult2.micDone}, cam=${muteResult2.camDone}`);

const MAX_RECORDING_SEC = parseInt(process.env.MAX_RECORDING_SEC || "7200", 10);
console.error(`[recorder] Запись активна. Макс. длительность: ${MAX_RECORDING_SEC}s. Ожидаем SIGTERM или конец встречи в UI...`);

// ── Graceful stop ────────────────────────────────────────────────────────────

let stopping = false;
let autoStopTimer = null;
let endMeetingPollTimer = null;

function readMeetingState() {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function finalizeStateAndNotify(stopReason) {
  if (stopReason === "signal") {
    return;
  }

  const state = readMeetingState();
  if (!state || Number(state.pid) !== process.pid) {
    console.error("[recorder] Финализация: state не найден или чужой PID — пропуск");
    return;
  }

  const startedAt = state.started_at || new Date().toISOString();
  let durationSec = 0;
  try {
    const startMs = new Date(startedAt).getTime();
    durationSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  } catch {
    durationSec = 0;
  }

  let fileSizeBytes = 0;
  try {
    fileSizeBytes = statSync(outputPath).size;
  } catch {
    fileSizeBytes = 0;
  }

  const payload = {
    file: state.file,
    title: state.title,
    started_at: startedAt,
    duration_sec: durationSec,
    file_size_bytes: fileSizeBytes,
    trigger: stopReason,
  };

  try {
    unlinkSync(STATE_FILE);
    console.error("[recorder] State file удалён после автоостановки");
  } catch (err) {
    console.error("[recorder] Не удалось удалить state file:", err.message);
  }

  const webhookUrl = process.env.TELEMOST_FINISH_WEBHOOK_URL;
  if (!webhookUrl) {
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    console.error(`[recorder] TELEMOST_FINISH_WEBHOOK_URL → HTTP ${response.status}`);
  } catch (err) {
    console.error("[recorder] Ошибка webhook:", err.message);
  }
}

async function stopRecording(stopReason = "signal") {
  if (stopping) return;
  stopping = true;

  console.error(`[recorder] Останавливаем запись (причина: ${stopReason})...`);

  if (endMeetingPollTimer) {
    clearInterval(endMeetingPollTimer);
    endMeetingPollTimer = null;
  }

  try {
    await page.evaluate(() => {
      if (window.__stopRecorder) window.__stopRecorder();
    });
  } catch {
    // страница уже закрыта
  }

  await new Promise((r) => setTimeout(r, 2000));

  if (autoStopTimer) {
    clearTimeout(autoStopTimer);
    autoStopTimer = null;
  }

  try {
    await browser.close();
  } catch {
    // ignore
  }
  try {
    xvfb.stop();
  } catch {
    // ignore
  }

  console.error(`[recorder] Запись сохранена: ${outputPath}`);

  await finalizeStateAndNotify(stopReason);

  process.exit(0);
}

autoStopTimer = setTimeout(() => {
  console.error(`[recorder] Автоматическая остановка по таймауту (${MAX_RECORDING_SEC}s)`);
  stopRecording("timeout");
}, MAX_RECORDING_SEC * 1000);

function startMeetingEndPolling() {
  const periodMs =
    Math.max(3, parseInt(process.env.TELEMOST_END_POLL_SEC || "8", 10)) * 1000;
  const markersRaw = process.env.TELEMOST_END_TEXT_MARKERS;
  const textMarkers =
    markersRaw === undefined || markersRaw.trim() === ""
      ? []
      : markersRaw
          .split(",")
          .map((segment) => segment.trim().toLowerCase())
          .filter((segment) => segment.length > 0);

  endMeetingPollTimer = setInterval(async () => {
    if (stopping) return;
    try {
      const endedByUi = await page.evaluate((joinPath) => {
        try {
          if (!joinPath || !joinPath.startsWith("/j/")) {
            return false;
          }
          const host = window.location.hostname || "";
          if (!host.includes("telemost.yandex.ru")) {
            return false;
          }
          const path = window.location.pathname || "";
          const onTelemostHome = path === "/" || path === "";
          if (!onTelemostHome) {
            return false;
          }
          const hasCreateCallButton =
            document.querySelector('[data-testid="create-call-button"]') !== null;
          return hasCreateCallButton;
        } catch {
          return false;
        }
      }, joinMeetingPathname);

      let endedByText = false;
      if (textMarkers.length > 0) {
        endedByText = await page.evaluate((markers) => {
          const pageText = (document.body?.innerText || "").toLowerCase();
          return markers.some((marker) => pageText.includes(marker));
        }, textMarkers);
      }

      if (endedByUi || endedByText) {
        console.error(
          endedByUi
            ? "[recorder] Встреча завершена: переход на главную Телемоста (pathname /, create-call-button)"
            : "[recorder] Встреча завершена: TELEMOST_END_TEXT_MARKERS",
        );
        if (endMeetingPollTimer) {
          clearInterval(endMeetingPollTimer);
          endMeetingPollTimer = null;
        }
        await stopRecording("ui_end");
      }
    } catch (err) {
      console.error("[recorder] Опрос «конец встречи»:", err.message);
    }
  }, periodMs);
}

startMeetingEndPolling();

process.on("SIGINT", () => {
  stopRecording("signal");
});
process.on("SIGTERM", () => {
  stopRecording("signal");
});
