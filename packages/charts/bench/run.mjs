// Прототип 2B.1: замер кадров при pan/zoom на 5 000 свечах, 2 панели, одна трендовая линия.
// Запуск: node bench/run.mjs [--throttle 4] [--n 5000]. Выводит p50/p95 кадра, долю > 16 мс, первый кадр.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const THROTTLE = Number(opt("throttle", 4));
const N = Number(opt("n", 5000));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json" };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

function stats(frames) {
  const f = frames.filter((x) => x > 0).sort((a, b) => a - b);
  const q = (p) => f[Math.min(f.length - 1, Math.floor(p * f.length))] ?? 0;
  return { n: f.length, p50: q(0.5).toFixed(1), p95: q(0.95).toFixed(1), slow: ((f.filter((x) => x > 20).length / f.length) * 100).toFixed(1), total: f.reduce((a, b) => a + b, 0).toFixed(0) };
}

async function bench(name, file, device) {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/bench/${file}?n=${N}`);
  try {
    await page.waitForFunction(() => window.__firstFrame != null, null, { timeout: 30000 });
  } catch (e) {
    await browser.close();
    throw new Error(`${name} ${device ?? "desktop"}: не дождались первого кадра. Ошибки: ${errors.join("; ") || "нет"}`);
  }
  const first = await page.evaluate(() => window.__firstFrame);
  // pan: 120 шагов по 3 бара, каждый в своём кадре
  await page.evaluate(() => window.__resetFrames());
  await page.evaluate(async () => { for (let i = 0; i < 120; i++) { window.__panBy(3); await new Promise((r) => requestAnimationFrame(r)); } });
  const pan = stats(await page.evaluate(() => window.__frames));
  // zoom: 40 шагов увеличения и 40 уменьшения
  await page.evaluate(() => window.__resetFrames());
  await page.evaluate(async () => { for (let i = 0; i < 40; i++) { window.__zoomBy(0.97); await new Promise((r) => requestAnimationFrame(r)); } for (let i = 0; i < 40; i++) { window.__zoomBy(1.03); await new Promise((r) => requestAnimationFrame(r)); } });
  const zoom = stats(await page.evaluate(() => window.__frames));
  await browser.close();
  return { name, device: device ?? "desktop 1280×800", first: first.toFixed(0), pan, zoom, errors };
}

const rows = [];
for (const device of [null, "iPhone 11", "Pixel 5"]) {
  rows.push(await bench("LWC v5", "lwc.html", device));
  rows.push(await bench("KLineChart v10", "kline.html", device));
}
server.close();
console.log(`CPU throttle ×${THROTTLE}, ${N} свечей, 2 панели, 1 трендовая линия`);
console.log("| Движок | Устройство (эмуляция) | Первый кадр, мс | Pan p50/p95, мс | Pan кадров > 20 мс | Pan всего, мс | Zoom p50/p95, мс | Zoom кадров > 20 мс | Zoom всего, мс |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.device} | ${r.first} | ${r.pan.p50} / ${r.pan.p95} | ${r.pan.slow} % | ${r.pan.total} | ${r.zoom.p50} / ${r.zoom.p95} | ${r.zoom.slow} % | ${r.zoom.total} |`);
for (const r of rows) if (r.errors.length) console.log(`ошибки ${r.name} ${r.device}: ${r.errors.join("; ")}`);
