// Isolated UI verification helper. Usage: node test/browser.mjs <shots-directory>
import { createRequire } from "node:module";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
const require = createRequire(new URL("../../../paseo/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const shots = process.argv[2];
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({
  executablePath: path.join(
    process.env.LOCALAPPDATA,
    "ms-playwright/chromium-1228/chrome-win64/chrome.exe",
  ),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  colorScheme: "dark",
});
const page = await context.newPage();
const errors = [];
let credentialFrames = 0;
page.on("pageerror", (error) => errors.push(error.message));
page.on("websocket", (socket) => {
  socket.on("framereceived", ({ payload }) => {
    if (payload.toString().includes("sk-test-xxxx")) credentialFrames++;
  });
});
await page.goto("http://127.0.0.1:16879");
console.log("BROWSER READY");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  try {
    // Commands are provided by the developer at the terminal, never by page content.
    const result = await eval(`(async()=>{${line}})()`);
    console.log(JSON.stringify(result ?? { errors, credentialFrames }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
  }
}
await browser.close();
