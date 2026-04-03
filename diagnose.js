import { launch } from "puppeteer-stream";
import { homedir } from "os";
import { join } from "path";
import { readdirSync, existsSync } from "fs";
import Xvfb from "xvfb";

const xvfb = new Xvfb({ silent: true, xvfb_args: ["-screen", "0", "1280x720x24", "-ac"] });
xvfb.start(() => {});

const cacheDir = join(homedir(), ".cache", "puppeteer", "chrome");
const ver = readdirSync(cacheDir).sort().reverse()[0];
const exe = join(cacheDir, ver, "chrome-linux64", "chrome");

const browser = await launch({
  headless: false, executablePath: exe, defaultViewport: null,
  ignoreDefaultArgs: ["--mute-audio"],
  env: { ...process.env, DISPLAY: xvfb._display },
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--use-fake-ui-for-media-stream",
    "--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli",
    "--window-size=1280,720", "--display=" + xvfb._display],
});
const page = await browser.newPage();
await page.goto("https://telemost.yandex.ru/j/8117669128", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));
await page.screenshot({ path: "/tmp/telemost_bot_page.png", fullPage: true });
console.log("Screenshot: /tmp/telemost_bot_page.png");
const title = await page.title();
const url = page.url();
console.log("Title:", title);
console.log("URL:", url);
const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
console.log("Body:", bodyText);
await browser.close();
xvfb.stop();
process.exit(0);
