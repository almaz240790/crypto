// Проверка словаря переводов (ADR-0005): каждый ключ en.json и en.signals.json должен встречаться в коде как
// t("ключ"), иначе перевод «осиротел» после правки русской фразы. Переводы о сигналах — только в en.signals.json
// (ADR-0013): общий en.json попадает в JS каждой страницы. Запуск: node scripts/check-i18n.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (name) => JSON.parse(readFileSync(new URL(`../src/i18n/${name}`, import.meta.url), "utf8"));
const common = read("en.json");
const signals = read("en.signals.json");
const dup = Object.keys(signals).filter((k) => k in common);
if (dup.length) {
  console.error(`check-i18n: ключи и в en.json, и в en.signals.json:\n  ${dup.join("\n  ")}`);
  process.exit(1);
}
// О сигналах (лента, статистика, форвард, бэктест, стратегия, движок и трекер) — в en.signals.json; оговорки
// «не является сигналом», «без сигнала» и общий «Движок» (статус API в подвале главной) остаются общими.
const SIGNAL_RE = /сигнал|форвард|бэктест|стратеги|трекер|движок|движка/i;
const COMMON_OK = /не (явля[а-яё]+ )?сигнал|не сигнал|без сигнал|до появления сигнала|^Движок(: нет связи с API)?$|^Статус движка и бирж/;
const misplaced = Object.keys(common).filter((k) => SIGNAL_RE.test(k) && !COMMON_OK.test(k));
if (misplaced.length) {
  console.error(`check-i18n: переводы о сигналах — в en.signals.json, не в общий en.json (ADR-0013):\n  ${misplaced.join("\n  ")}`);
  process.exit(1);
}
const dict = { ...common, ...signals };
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
console.log(`check-i18n: ok (${Object.keys(common).length} общих переводов и ${Object.keys(signals).length} о сигналах)`);
