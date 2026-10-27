// Проверка словаря переводов (ADR-0005): каждый ключ en.json должен встречаться в коде как t("ключ"),
// иначе перевод «осиротел» после правки русской фразы. Запуск: node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dict = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|mjs)$/.test(n) && !p.includes("/i18n/")) files.push(p);
  }
};
walk(new URL("../src", import.meta.url).pathname);
const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
const orphan = Object.keys(dict).filter((k) => !src.includes(JSON.stringify(k)) && !src.includes(`t("${k}")`));
if (orphan.length) {
  console.error(`check-i18n: ${orphan.length} ключей словаря не найдены в коде:\n  ${orphan.join("\n  ")}`);
  process.exit(1);
}
const empty = Object.entries(dict).filter(([, v]) => !v || v === "");
if (empty.length) {
  console.error(`check-i18n: пустые переводы: ${empty.map(([k]) => k).join(", ")}`);
  process.exit(1);
}
console.log(`check-i18n: ok (${Object.keys(dict).length} переводов)`);
