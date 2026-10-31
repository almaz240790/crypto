import type { NextRequest } from "next/server";

/**
 * Прокси браузерных запросов к API на том же домене: /v1/* → ${API_URL}/v1/*.
 * Адрес читается во время работы (не при сборке образа). Cookie refresh (path=/v1/auth)
 * остаётся first-party, CORS не нужен.
 */
export const dynamic = "force-dynamic";

/**
 * if-none-match / etag / age — ревалидация /v1/chart: повторный запрос получает 304 без тела (план 2B.4).
 * cdn-cache-control — свежесть для edge (Cloudflare перед этим прокси); браузер его не читает.
 */
const PASS_REQ = ["content-type", "authorization", "cookie", "accept", "user-agent", "accept-language", "if-none-match"];
const PASS_RES = ["content-type", "cache-control", "cdn-cache-control", "content-disposition", "retry-after", "etag", "age"];
/** Статусы без тела: Response с телом для них бросает исключение. */
const NULL_BODY = new Set([204, 205, 304]);

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const base = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const { path } = await ctx.params;
  const url = new URL(`${base}/v1/${path.map(encodeURIComponent).join("/")}`);
  url.search = req.nextUrl.search;

  const headers = new Headers();
  for (const h of PASS_REQ) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const ip = req.headers.get("x-forwarded-for");
  if (ip) headers.set("x-forwarded-for", ip);

  const hasBody = !["GET", "HEAD"].includes(req.method);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "API недоступен" }, { status: 502 });
  }

  const out = new Headers();
  for (const h of PASS_RES) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of upstream.headers.getSetCookie()) out.append("set-cookie", c);
  return new Response(NULL_BODY.has(upstream.status) ? null : upstream.body, { status: upstream.status, headers: out });
}

export { proxy as DELETE, proxy as GET, proxy as HEAD, proxy as PATCH, proxy as POST, proxy as PUT };
