#!/usr/bin/env node
/**
 * Снимает «отпечаток» DOM/URL Телемоста каждые N секунд в JSON Lines.
 * Нужен, чтобы зафиксировать стабильные data-testid / URL после «Закончить встречу».
 * Вывод: при завершении pathname меняется с /j/<id> на /, появляется create-call-button
 * (см. recorder.js — детект по этим признакам).
 *
 * Запуск на сервере (после установки Chrome для Puppeteer):
 *   cd /opt/telemost-recorder
 *   node probe_meeting_ui.js "https://telemost.yandex.ru/j/XXXXXXXX"
 *
 * Действия: дождаться входа бота в комнату, провести встречу, нажать «Закончить встречу»,
 * подождать 10–15 с, затем Ctrl+C — в логе будут строки до и после завершения.
 *
 * Переменные окружения:
 *   PROBE_OUT — файл лога (по умолчанию /tmp/telemost_ui_probe.jsonl)
 *   PROBE_INTERVAL_SEC — интервал опроса (по умолчанию 3)
 *   BOT_DISPLAY_NAME — имя участника (как у recorder.js)
 */

import puppeteer from "puppeteer";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Xvfb from "xvfb";

const joinUrl = process.argv[2];
if (!joinUrl || joinUrl.startsWith("-")) {
  console.error(
    "Использование: node probe_meeting_ui.js <join_url>\nПример: node probe_meeting_ui.js \"https://telemost.yandex.ru/j/1234567890\"",
  );
  process.exit(1);
}

const probeOut = process.env.PROBE_OUT || "/tmp/telemost_ui_probe.jsonl";
const intervalSec = Math.max(1, parseInt(process.env.PROBE_INTERVAL_SEC || "3", 10));
const botName = process.env.BOT_DISPLAY_NAME || "Бот-записи";

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
  console.error("[probe] Chrome не найден. Запустите: npx puppeteer browsers install chrome");
  process.exit(1);
}

const xvfb = new Xvfb({
  silent: true,
  xvfb_args: ["-screen", "0", "1280x720x24", "-ac"],
});

await new Promise((resolvePromise, rejectPromise) => {
  xvfb.start((err) => {
    if (err) rejectPromise(err);
    else resolvePromise();
  });
});

console.error(`[probe] Лог: ${probeOut} (интервал ${intervalSec}s)`);
console.error(`[probe] Остановка: Ctrl+C после завершения встречи в UI`);
writeFileSync(probeOut, "");

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
    "Chrome/131.0.0.0 Safari/537.36",
);

await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));

const nameInput = await page.$('input[placeholder*="имя"], input[name*="name"], input[type="text"]');
if (nameInput) {
  await nameInput.click({ clickCount: 3 });
  await nameInput.type(botName);
}

async function clickMuteIfPresent() {
  await page.evaluate(() => {
    const micBtn = document.querySelector('[data-testid="turn-off-mic-button"]');
    if (micBtn) micBtn.click();
    const camBtn = document.querySelector('[data-testid="turn-off-camera-button"]');
    if (camBtn) camBtn.click();
  });
}

await clickMuteIfPresent();

const joinButton = await page.evaluateHandle(() => {
  const buttons = [...document.querySelectorAll("button, [role='button']")];
  return buttons.find((b) => /подключиться|присоединиться|join/i.test(b.textContent));
});

if (joinButton && joinButton.asElement()) {
  await joinButton.asElement().click();
  console.error("[probe] Нажато Подключиться — ждём комнату…");
}

await new Promise((r) => setTimeout(r, 12000));
await clickMuteIfPresent();

function takeSnapshot() {
  return page.evaluate(() => {
    const testIdNodes = [...document.querySelectorAll("[data-testid]")];
    const dataTestIds = testIdNodes.map((el) => ({
      testid: el.getAttribute("data-testid") || "",
      tag: el.tagName,
      ariaLabel: el.getAttribute("aria-label") || "",
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    }));

    const roleButtons = [...document.querySelectorAll("button,[role='button']")].map((el) => ({
      tag: el.tagName,
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
      testid: el.getAttribute("data-testid") || "",
    }));

    const headings = [...document.querySelectorAll('[role="heading"],h1,h2,h3')].map((el) =>
      (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200),
    );

    const bodySample = (document.body?.innerText || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 500);

    const testIdFingerprint = [...new Set(dataTestIds.map((x) => x.testid).filter(Boolean))]
      .sort()
      .join("|");

    return {
      href: window.location.href,
      pathname: window.location.pathname,
      title: document.title,
      dataTestIds,
      roleButtons,
      headings,
      bodySample,
      testIdFingerprint,
    };
  });
}

async function appendProbeLine(phase) {
  const snapshot = await takeSnapshot();
  const line = {
    ts: new Date().toISOString(),
    phase,
    ...snapshot,
  };
  const jsonLine = JSON.stringify(line) + "\n";
  appendFileSync(probeOut, jsonLine, "utf8");
  console.error(
    `[probe] ${line.ts} ${phase} url=${line.pathname} fp=${line.testIdFingerprint.slice(0, 80)}…`,
  );
}

let tickCount = 0;
const timer = setInterval(async () => {
  tickCount += 1;
  try {
    await appendProbeLine(`tick_${tickCount}`);
  } catch (err) {
    console.error("[probe] Ошибка снимка:", err.message);
  }
}, intervalSec * 1000);

await appendProbeLine("after_join");

async function shutdown(phase) {
  clearInterval(timer);
  try {
    await appendProbeLine(phase);
  } catch (err) {
    console.error("[probe] Финальный снимок:", err.message);
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
  console.error(`[probe] Готово. Пришлите файл (или последние 30–50 строк): ${probeOut}`);
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("sigint");
});
process.on("SIGTERM", () => {
  void shutdown("sigterm");
});
