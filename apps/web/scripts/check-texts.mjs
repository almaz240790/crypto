#!/usr/bin/env node
/**
 * Линтер текстов интерфейса (план 2A.10.6, раздел 8): запрещённые формулировки в строках src/**.
 * Ищет в .ts/.tsx/.md обещания доходности, «ИИ предсказывает», «сигнал на покупку» для паттернов и т. п.
 * Исключение для строки: пометка // text-ok (например, сам словарь запретов).
 * Использование: node scripts/check-texts.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const EXT = [".ts", ".tsx", ".md"];
const FORBIDDEN = [
  /ии\s+предсказыва/i,
  /ии\s+рекоменду/i,
  /сигнал\s+на\s+покупку/i,
  /сигнал\s+на\s+продажу/i,
  /вероятность\s+роста/i,
  /вероятность\s+падения/i,
  /точность\s+\d+\s*%/i,
  /гарантир\w*\s+(доход|прибыл)/i,
  /обещ\w*\s+(доход|прибыл)/i,
  /\d+\s*%\s+(в\s+месяц|в\s+день|годовых)/i,
];
const OK = /text-ok/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (OK.test(line)) return;
    for (const re of FORBIDDEN) {
      const m = line.match(re);
      if (m) problems.push(`${rel}:${i + 1}: «${m[0]}»`);
    }
  });
}
if (problems.length) {
  console.error("check-texts: запрещённые формулировки (план 2A.10.6):\n" + problems.join("\n"));
  process.exit(1);
}
console.log("check-texts: ok");
