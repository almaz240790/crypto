#!/usr/bin/env node
/**
 * Запрет произвольных цветов вне токенов (план 2.6, 5.3).
 * Ищет литералы #hex, rgb(), hsl() и именованные цвета в src/**, кроме src/styles/tokens.css.
 * Использование: node scripts/check-colors.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const ALLOW = new Set(["src/styles/tokens.css"]);
const EXT = new Set([".css", ".ts", ".tsx", ".js", ".jsx", ".mjs"]);

const HEX = /#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const FUNC = /\b(?:rgba?|hsla?|oklch|lab|lch)\(/gi;
const NAMED = /(?:^|[\s:;,(])(white|black|red|green|blue|purple|violet|pink|orange|yellow|gray|grey|cyan|magenta|lime|teal|navy|silver|gold|indigo)\b(?=\s*[;,)!}]|\s+[0-9a-z#])/gi;
// Исключения: строки-комментарии и data-URL в CSS можно пометить /* color-ok */.
const OK = /color-ok/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if ([...EXT].some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file);
  if (ALLOW.has(rel)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (OK.test(line)) return;
    // Разрешаем #id-селекторы и ссылки на якоря: только в CSS и только если не похоже на hex.
    const hits = [];
    for (const m of line.matchAll(HEX)) {
      const before = line.slice(0, m.index);
      // "#abc" в href="#abc" или в селекторе CSS — пропускаем
      if (/href=["']$/.test(before) || /url\(["']?$/.test(before)) continue;
      if (rel.endsWith(".css") && /^\s*$/.test(before)) continue; // #id { — селектор
      hits.push(m[0]);
    }
    for (const m of line.matchAll(FUNC)) hits.push(m[0]);
    for (const m of line.matchAll(NAMED)) hits.push(m[1]);
    if (hits.length) problems.push(`${rel}:${i + 1}: ${hits.join(", ")}  |  ${line.trim()}`);
  });
}

if (problems.length) {
  console.error("Найдены цвета вне токенов (src/styles/tokens.css):\n" + problems.join("\n"));
  process.exit(1);
}
console.log("check-colors: ok");
