import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { GET } from "./route";

/** Прокси /v1/*: ревалидация /v1/chart (план 2B.4) — If-None-Match вверх, ETag/Age/Cache-Control вниз, 304 без тела. */
function request(headers: Record<string, string>): NextRequest {
  const url = new URL("http://localhost/v1/chart/candles?symbol=BTCUSDT&tf=4h");
  return { method: "GET", headers: new Headers(headers), nextUrl: url } as unknown as NextRequest;
}
const ctx = { params: Promise.resolve({ path: ["chart", "candles"] }) };
const CC = "public, max-age=0, s-maxage=10, stale-while-revalidate=30";

afterEach(() => vi.unstubAllGlobals());

describe("прокси /v1", () => {
  it("передаёт If-None-Match и отдаёт 304 без тела с ETag, Age и Cache-Control", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304, headers: { etag: 'W/"0123456789abcdef"', age: "4", "cache-control": CC } }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await GET(request({ "if-none-match": 'W/"0123456789abcdef"', accept: "application/json" }), ctx);
    const init = (fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(new Headers(init.headers).get("if-none-match")).toBe('W/"0123456789abcdef"');
    expect(r.status).toBe(304);
    expect(r.body).toBeNull();
    expect(r.headers.get("etag")).toBe('W/"0123456789abcdef"');
    expect(r.headers.get("age")).toBe("4");
    expect(r.headers.get("cache-control")).toBe(CC);
  });

  it("200: тело и ETag как у API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"candles":[]}', { status: 200, headers: { "content-type": "application/json", etag: 'W/"aa"', "cache-control": CC } })));
    const r = await GET(request({}), ctx);
    expect(r.status).toBe(200);
    expect(r.headers.get("etag")).toBe('W/"aa"');
    expect(await r.json()).toEqual({ candles: [] });
  });
});
