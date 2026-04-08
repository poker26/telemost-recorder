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
  mkdtempSync,
  rmSync,
} from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import { execSync } from "child_process";
import Xvfb from "xvfb";

const recorderScriptDir = dirname(fileURLToPath(import.meta.url));

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

if (process.env.TELEMOST_FINISH_WEBHOOK_URL) {
  console.error("[recorder] TELEMOST_FINISH_WEBHOOK_URL задан — после автоостановки будет POST в n8n");
} else {
  console.error(
    "[recorder] ВНИМАНИЕ: TELEMOST_FINISH_WEBHOOK_URL не задан — при завершении встречи в Телемосте n8n и Telegram не вызовутся (нужен отдельный Webhook workflow, см. README).",
  );
}

const outputPath = resolve(outputFile);
console.error(`[recorder] join_url: ${joinUrl}`);
console.error(`[recorder] output:   ${outputPath}`);
const chromeUserDataDir = mkdtempSync(join(tmpdir(), "telemost-puppeteer-"));
console.error(`[recorder] Chrome profile: ${chromeUserDataDir}`);

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

function startXvfb() {
  return new Promise((resolveStart, rejectStart) => {
    xvfb.start((err) => {
      if (err) {
        rejectStart(err);
        return;
      }
      resolveStart();
    });
  });
}

await startXvfb();
console.error(`[recorder] Xvfb display: ${xvfb._display}`);

function buildMinioEndpointUrlForS3Client() {
  const raw = process.env.MINIO_ENDPOINT?.trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/$/, "");
  }
  const useSsl = (process.env.MINIO_USE_SSL || "true").toLowerCase() === "true";
  const scheme = useSsl ? "https" : "http";
  return `${scheme}://${raw.replace(/\/$/, "")}`;
}

async function readS3ObjectBodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function detectImageExtensionFromBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return ".webp";
  }
  return "";
}

function bufferLooksLikeS3XmlError(buffer) {
  const head = buffer.slice(0, 80).toString("utf8").trimStart();
  return head.startsWith("<") || head.startsWith("<?xml");
}

async function syncLobbyAvatarFromMinioToDefaultFile() {
  const endpointUrl = buildMinioEndpointUrlForS3Client();
  const accessKeyId = process.env.MINIO_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.MINIO_SECRET_KEY?.trim();
  const bucket = process.env.MINIO_BUCKET_MEDIA?.trim();
  const objectKey = (process.env.MINIO_AVATAR_OBJECT_KEY || "avatar.jpg").trim();

  if (!endpointUrl || !accessKeyId || !secretAccessKey || !bucket) {
    return;
  }

  const jpgPath = join(recorderScriptDir, ".telemost_bot_avatar.jpg");
  const pngPath = join(recorderScriptDir, ".telemost_bot_avatar.png");
  const webpPath = join(recorderScriptDir, ".telemost_bot_avatar.webp");

  try {
    const s3Module = await import("@aws-sdk/client-s3");
    const S3Client = s3Module.S3Client;
    const GetObjectCommand = s3Module.GetObjectCommand;

    const s3Client = new S3Client({
      region: "us-east-1",
      endpoint: endpointUrl,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });

    const getResponse = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    );

    if (!getResponse.Body) {
      console.error("[recorder] MinIO GetObject: пустое тело для аватара");
      return;
    }

    const buffer = await readS3ObjectBodyToBuffer(getResponse.Body);

    if (buffer.length === 0) {
      console.error(
        `[recorder] MinIO: объект ${bucket}/${objectKey} пустой (0 байт) — в бакете нет данных`,
      );
      return;
    }

    if (bufferLooksLikeS3XmlError(buffer)) {
      console.error(
        `[recorder] MinIO: ответ похож на XML-ошибку S3, не на картинку. Первые 300 символов:\n${buffer.slice(0, 300).toString("utf8")}`,
      );
      return;
    }

    const ext = detectImageExtensionFromBuffer(buffer);
    if (!ext) {
      console.error(
        `[recorder] MinIO: скачано ${buffer.length} байт, но сигнатура не JPEG/PNG/WebP — в лобби не подставляю. Hex: ${buffer.slice(0, 16).toString("hex")}`,
      );
      return;
    }

    try {
      unlinkSync(jpgPath);
    } catch {
      // ignore
    }
    try {
      unlinkSync(pngPath);
    } catch {
      // ignore
    }
    try {
      unlinkSync(webpPath);
    } catch {
      // ignore
    }

    let destinationPath = jpgPath;
    if (ext === ".png") {
      destinationPath = pngPath;
    } else if (ext === ".webp") {
      destinationPath = webpPath;
    }
    writeFileSync(destinationPath, buffer);

    const absoluteForPuppeteer = resolve(destinationPath);
    console.error(
      `[recorder] Аватар лобби: MinIO ${bucket}/${objectKey} → ${absoluteForPuppeteer} (${buffer.length} байт, ${ext})`,
    );
  } catch (syncError) {
    const code = syncError?.code;
    const message = syncError?.message || String(syncError);
    if (code === "ERR_MODULE_NOT_FOUND" || message.includes("@aws-sdk/client-s3")) {
      console.error(
        "[recorder] MinIO: пакет @aws-sdk/client-s3 не установлен. В каталоге проекта выполните: npm install",
      );
      return;
    }
    console.error(
      `[recorder] MinIO: не удалось скачать аватар (${bucket}/${objectKey}): ${message}`,
    );
  }
}

function resolveLobbyAvatarAbsolutePath() {
  const configuredPath = process.env.BOT_LOBBY_AVATAR_PATH;
  if (configuredPath) {
    const absoluteConfigured = resolve(configuredPath);
    if (existsSync(absoluteConfigured)) {
      return absoluteConfigured;
    }
    console.error(
      `[recorder] BOT_LOBBY_AVATAR_PATH задан, файл не найден: ${absoluteConfigured}`,
    );
  }
  const jpgPath = join(recorderScriptDir, ".telemost_bot_avatar.jpg");
  const pngPath = join(recorderScriptDir, ".telemost_bot_avatar.png");
  const webpPath = join(recorderScriptDir, ".telemost_bot_avatar.webp");
  if (existsSync(jpgPath)) {
    return resolve(jpgPath);
  }
  if (existsSync(pngPath)) {
    return resolve(pngPath);
  }
  if (existsSync(webpPath)) {
    return resolve(webpPath);
  }
  return null;
}

// ── Write empty file so stop_meeting.sh sees it ──────────────────────────────

writeFileSync(outputPath, "");

// ── Browser launch ───────────────────────────────────────────────────────────

let browser = null;
let page = null;
let cleanupInProgress = false;

async function closeBrowserGracefully() {
  if (!browser) {
    return;
  }
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, rejectClose) => {
        setTimeout(() => rejectClose(new Error("browser.close timeout")), 7000);
      }),
    ]);
  } catch (closeError) {
    console.error("[recorder] browser.close() не успел/упал, делаем kill процесса браузера");
    try {
      const browserProcess = browser.process();
      if (browserProcess?.pid) {
        process.kill(browserProcess.pid, "SIGKILL");
      }
    } catch {
      // ignore
    }
  } finally {
    browser = null;
  }
}

function killChromeByProfilePath(profilePath) {
  if (!profilePath) {
    return;
  }
  try {
    execSync(`pkill -TERM -f "${profilePath}"`, { stdio: "ignore" });
  } catch {
    // no processes matched
  }
  try {
    execSync(`pkill -KILL -f "${profilePath}"`, { stdio: "ignore" });
  } catch {
    // no processes matched
  }
}

function stopXvfbSafely() {
  try {
    xvfb.stop();
  } catch {
    // ignore
  }
}

function removeChromeProfileDir(profilePath) {
  try {
    rmSync(profilePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function cleanupResources(reason) {
  if (cleanupInProgress) {
    return;
  }
  cleanupInProgress = true;
  console.error(`[recorder] cleanupResources: ${reason}`);
  try {
    if (page) {
      try {
        await page.close({ runBeforeUnload: false });
      } catch {
        // ignore
      } finally {
        page = null;
      }
    }
    await closeBrowserGracefully();
    killChromeByProfilePath(chromeUserDataDir);
  } finally {
    stopXvfbSafely();
    removeChromeProfileDir(chromeUserDataDir);
    cleanupInProgress = false;
  }
}

process.on("SIGINT", () => {
  stopRecording("signal");
});
process.on("SIGTERM", () => {
  stopRecording("signal");
});
process.on("uncaughtException", async (error) => {
  try {
    console.error("[recorder] uncaughtException:", error?.stack || error?.message || String(error));
    await cleanupResources("uncaughtException");
  } finally {
    process.exit(1);
  }
});
process.on("unhandledRejection", async (reason) => {
  try {
    const text = reason?.stack || reason?.message || String(reason);
    console.error("[recorder] unhandledRejection:", text);
    await cleanupResources("unhandledRejection");
  } finally {
    process.exit(1);
  }
});

browser = await puppeteer.launch({
  headless: false,
  executablePath,
  userDataDir: chromeUserDataDir,
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

page = await browser.newPage();

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

await syncLobbyAvatarFromMinioToDefaultFile();

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

const lobbyAvatarPath = resolveLobbyAvatarAbsolutePath();
if (lobbyAvatarPath) {
  try {
    const lobbyAvatarStat = statSync(lobbyAvatarPath);
    console.error(
      `[recorder] Аватар лобби (файл): ${lobbyAvatarPath} (${lobbyAvatarStat.size} байт)`,
    );
  } catch {
    console.error(`[recorder] Аватар лобби (файл): ${lobbyAvatarPath}`);
  }
}

const LOBBY_AVATAR_SELECTOR_HINTS = [
  '[data-testid*="avatar" i]',
  "button[aria-label*='фото' i]",
  "button[aria-label*='Фото' i]",
  "button[aria-label*='аватар' i]",
  "button[aria-label*='Аватар' i]",
  "[data-testid*='userpic' i]",
  "[data-testid*='Userpic' i]",
  'img[alt*="аватар" i]',
  'img[alt*="Аватар" i]',
];

function listActiveFramesForLobbyScan() {
  return page.frames();
}

async function tryUploadFileToEveryInputInAllFrames(pathForChromium) {
  const frames = listActiveFramesForLobbyScan();
  for (const frame of frames) {
    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch {
      frameUrl = "(url недоступен)";
    }
    let handles = [];
    try {
      handles = await frame.$$('input[type="file"]');
    } catch (frameErr) {
      console.error(
        `[recorder] фрейм ${frameUrl}: не удалось искать input file — ${frameErr?.message || String(frameErr)}`,
      );
      continue;
    }
    for (const inputHandle of handles) {
      try {
        await inputHandle.uploadFile(pathForChromium);
        await new Promise((r) => setTimeout(r, 800));
        return { ok: true, frameUrl };
      } catch (uploadErr) {
        console.error(
          `[recorder] uploadFile (${frameUrl}): ${uploadErr?.message || String(uploadErr)} (путь: ${pathForChromium})`,
        );
      }
    }
  }
  return { ok: false };
}

async function frameHasAvatarHintElement(frame) {
  try {
    return await frame.evaluate((hints) => {
      for (const selector of hints) {
        if (document.querySelector(selector)) {
          return true;
        }
      }
      return false;
    }, LOBBY_AVATAR_SELECTOR_HINTS);
  } catch {
    return false;
  }
}

async function clickFirstAvatarHintInFrame(frame) {
  return frame.evaluate((hints) => {
    for (const selector of hints) {
      const element = document.querySelector(selector);
      if (element && typeof element.click === "function") {
        element.click();
        return selector;
      }
    }
    return null;
  }, LOBBY_AVATAR_SELECTOR_HINTS);
}

async function tryFileChooserAcceptAfterAvatarClickInFrames(pathForChromium, fileChooserTimeoutMs) {
  const frames = listActiveFramesForLobbyScan();
  const timeoutMs = Math.max(2000, fileChooserTimeoutMs || 5000);

  for (const frame of frames) {
    const hasHint = await frameHasAvatarHintElement(frame);
    if (!hasHint) {
      continue;
    }

    let frameUrl = "";
    try {
      frameUrl = frame.url();
    } catch {
      frameUrl = "(url недоступен)";
    }

    try {
      const [fileChooser, selectorUsed] = await Promise.all([
        page.waitForFileChooser({ timeout: timeoutMs }),
        clickFirstAvatarHintInFrame(frame),
      ]);
      if (!selectorUsed) {
        continue;
      }
      await fileChooser.accept([pathForChromium]);
      await new Promise((r) => setTimeout(r, 700));
      return { ok: true, frameUrl, method: "file_chooser", selector: selectorUsed };
    } catch (chooserErr) {
      console.error(
        `[recorder] waitForFileChooser (${frameUrl}): ${chooserErr?.message || String(chooserErr)}`,
      );
    }
  }

  return { ok: false };
}

async function tryApplyLobbyAvatar(absoluteImagePath) {
  if (!absoluteImagePath || !existsSync(absoluteImagePath)) {
    return { applied: false, reason: "file_missing" };
  }

  const pathForChromium = resolve(absoluteImagePath);
  const fileChooserMs = parseInt(process.env.TELEMOST_LOBBY_FILE_CHOOSER_MS || "5000", 10);

  try {
    let uploadResult = await tryUploadFileToEveryInputInAllFrames(pathForChromium);
    if (uploadResult.ok) {
      await new Promise((r) => setTimeout(r, 700));
      return {
        applied: true,
        method: "file_input_all_frames",
        frameUrl: uploadResult.frameUrl,
      };
    }

    const chooserResult = await tryFileChooserAcceptAfterAvatarClickInFrames(
      pathForChromium,
      fileChooserMs,
    );
    if (chooserResult.ok) {
      return {
        applied: true,
        method: chooserResult.method,
        frameUrl: chooserResult.frameUrl,
        selector: chooserResult.selector,
      };
    }

    for (const frame of listActiveFramesForLobbyScan()) {
      let frameUrl = "";
      try {
        frameUrl = frame.url();
      } catch {
        frameUrl = "(url недоступен)";
      }
      try {
        const selectorUsed = await clickFirstAvatarHintInFrame(frame);
        if (selectorUsed) {
          console.error(
            `[recorder] Лобби: клик по аватару (${selectorUsed}) во фрейме ${frameUrl}`,
          );
        }
      } catch (clickErr) {
        console.error(
          `[recorder] клик аватар-hint (${frameUrl}): ${clickErr?.message || String(clickErr)}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, 600));

    uploadResult = await tryUploadFileToEveryInputInAllFrames(pathForChromium);
    if (uploadResult.ok) {
      await new Promise((r) => setTimeout(r, 700));
      return {
        applied: true,
        method: "after_avatar_click_all_frames",
        frameUrl: uploadResult.frameUrl,
      };
    }
  } catch (err) {
    console.error(`[recorder] Ошибка установки аватара: ${err.message}`);
    return { applied: false, reason: err.message };
  }

  return { applied: false, reason: "no_file_control" };
}

if (lobbyAvatarPath) {
  const avatarResult = await tryApplyLobbyAvatar(lobbyAvatarPath);
  console.error(`[recorder] Аватар лобби: ${JSON.stringify(avatarResult)}`);
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

  const chatIdFromState =
    state.telegram_chat_id != null && String(state.telegram_chat_id).trim() !== ""
      ? String(state.telegram_chat_id).trim()
      : "";
  const chatIdFromEnv = (process.env.TELEGRAM_NOTIFY_CHAT_ID || "").trim();
  const notifyChatId = chatIdFromState || chatIdFromEnv;
  if (notifyChatId) {
    payload.chat_id = notifyChatId;
  }

  try {
    unlinkSync(STATE_FILE);
    console.error("[recorder] State file удалён после автоостановки");
  } catch (err) {
    console.error("[recorder] Не удалось удалить state file:", err.message);
  }

  const webhookUrl = process.env.TELEMOST_FINISH_WEBHOOK_URL;
  if (!webhookUrl) {
    if (stopReason === "ui_end" || stopReason === "timeout") {
      console.error(
        "[recorder] Автоостановка без webhook: добавьте TELEMOST_FINISH_WEBHOOK_URL в .env.telemost и workflow в n8n (см. README).",
      );
    }
    return;
  }

  if (!notifyChatId) {
    console.error(
      "[recorder] ВНИМАНИЕ: webhook без chat_id — в Telegram не отправить. Задайте TELEGRAM_NOTIFY_CHAT_ID в .env.telemost или передавайте chat id вторым аргументом run_start.sh (обновите узел SSH «Start Meeting» в n8n).",
    );
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

  await cleanupResources(`stopRecording:${stopReason}`);

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
  const requireCreateCallButton = process.env.TELEMOST_END_RELAXED !== "1";
  const markersRaw = process.env.TELEMOST_END_TEXT_MARKERS;
  const textMarkers =
    markersRaw === undefined || markersRaw.trim() === ""
      ? []
      : markersRaw
          .split(",")
          .map((segment) => segment.trim().toLowerCase())
          .filter((segment) => segment.length > 0);

  let lastLoggedPathname = "";

  endMeetingPollTimer = setInterval(async () => {
    if (stopping) return;
    try {
      const pathNow = await page.evaluate(() => window.location.pathname || "");
      if (pathNow !== lastLoggedPathname) {
        console.error(`[recorder] pathname → ${pathNow}`);
        lastLoggedPathname = pathNow;
      }

      const endedByUi = await page.evaluate(
        (joinPath, strictCreate) => {
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
            if (!strictCreate) {
              return true;
            }
            return document.querySelector('[data-testid="create-call-button"]') !== null;
          } catch {
            return false;
          }
        },
        joinMeetingPathname,
        requireCreateCallButton,
      );

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
            ? `[recorder] Встреча завершена: главная Телемоста (/)${requireCreateCallButton ? ", create-call-button" : ", TELEMOST_END_RELAXED=1"}`
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
