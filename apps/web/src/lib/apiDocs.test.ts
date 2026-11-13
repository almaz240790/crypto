import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS } from "./apiDocs";

/** Список эндпоинтов, открытых ключу на сервере: строки KEY_ENDPOINTS в apps/api/app/apikeys.py. */
function serverKeyEndpoints(): string[] {
  const src = readFileSync(new URL("../../../api/app/apikeys.py", import.meta.url), "utf8");
  const block = src.match(/^KEY_ENDPOINTS = frozenset\(\s*\{([\s\S]*?)^\s*\}\s*\)/m);
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("API для чтения (ADR-0017)", () => {
  it("список /api-docs — тот же, что открывает ключ на сервере", () => {
    const paths = API_ENDPOINTS.map((e) => e.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect([...paths].sort()).toEqual(serverKeyEndpoints().sort());
  });
});
