import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, PUBLIC_API_BASE, apiKeyExample } from "./apiDocs";

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

  it("пример из настроек — настоящий запрос: адрес API, эндпоинт и параметры из документации, ключ целиком", () => {
    const key = "pk_abc1234SECRETSECRETSECRETSECRET";
    const cmd = apiKeyExample(key);
    expect(cmd).toContain(`-H "X-API-Key: ${key}"`);
    const quoted = cmd.match(/ "(https:[^"]+)"$/);
    expect(quoted).not.toBeNull();
    const url = new URL(quoted![1]);
    expect(url.origin).toBe(PUBLIC_API_BASE);
    const endpoint = API_ENDPOINTS.find((e) => e.path === url.pathname);
    expect(endpoint).toBeDefined();
    const allowed = endpoint!.params.split(",").map((p) => p.trim());
    expect([...url.searchParams.keys()].length).toBeGreaterThan(0);
    for (const name of url.searchParams.keys()) expect(allowed).toContain(name);
    // status — open | closed | all (GET /v1/signals)
    expect(["open", "closed", "all"]).toContain(url.searchParams.get("status"));
  });
});
