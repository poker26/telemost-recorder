import puppeteer from "puppeteer";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync } from "fs";
import Xvfb from "xvfb";

const joinUrl = process.argv[2] || "https://telemost.yandex.ru/j/TEST";

const xvfb = new Xvfb({ silent: true, xvfb_args: ["-screen", "0", "1280x720x24", "-ac"] });
xvfb.start(() => {});

const cacheDir = join(homedir(), ".cache", "puppeteer", "chrome");
const ver = readdirSync(cacheDir).sort().reverse()[0];
const exe = join(cacheDir, ver, "chrome-linux64", "chrome");

const browser = await puppeteer.launch({
  headless: false, executablePath: exe, defaultViewport: null,
  env: { ...process.env, DISPLAY: xvfb._display },
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream", "--window-size=1280,720",
    "--display=" + xvfb._display],
});

const page = await browser.newPage();
await page.goto(joinUrl, { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));

const buttons = await page.evaluate(() => {
  const result = [];
  const elements = document.querySelectorAll("button, [role='button'], [class*='button'], [class*='Button']");
  for (const el of elements) {
    result.push({
      tag: el.tagName,
      text: (el.textContent || "").trim().substring(0, 80),
      ariaLabel: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      className: (el.className || "").substring(0, 120),
      dataTestId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "",
    });
  }
  return result;
});

console.log("=== Кнопки на странице ===");
for (const btn of buttons) {
  console.log(JSON.stringify(btn));
}

await browser.close();
xvfb.stop();
process.exit(0);
