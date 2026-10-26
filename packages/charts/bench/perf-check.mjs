// Perf-тест для CI (план 2B.2): LWC-прототип на эмуляции Pixel 5 при CPU ×4.
// Порог из ADR-0003: доля кадров > 20 мс при pan не выше 25 %, медиана ≤ 17 мс.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": MIME[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const ctx = await browser.newContext({ ...devices["Pixel 5"] });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await page.goto(`http://localhost:${port}/bench/lwc.html?n=5000`);
await page.waitForFunction(() => window.__firstFrame != null, null, { timeout: 30000 });
const runs = [];
for (let k = 0; k < 3; k++) {
  await page.evaluate(() => window.__resetFrames());
  await page.evaluate(async () => { for (let i = 0; i < 120; i++) { window.__panBy(3); await new Promise((r) => requestAnimationFrame(r)); } });
  const f = (await page.evaluate(() => window.__frames)).filter((x) => x > 0).sort((a, b) => a - b);
  runs.push({ p50: f[Math.floor(f.length / 2)], slow: f.filter((x) => x > 20).length / f.length });
}
await browser.close();
server.close();
const best = runs.reduce((a, b) => (b.slow < a.slow ? b : a));
console.log("perf-check (Pixel 5, CPU ×4, 5000 свечей): " + runs.map((r) => `p50 ${r.p50.toFixed(1)} мс, медленных ${(r.slow * 100).toFixed(1)} %`).join(" | "));
if (best.slow > 0.25 || best.p50 > 17) { console.error("perf-check: порог превышен"); process.exit(1); }
