/**
 * Подпись прокси сайта для API (ADR-0011). Если задан общий секрет PROXY_SECRET, прокси /v1 добавляет к запросу
 * секрет и адрес клиента, который увидел сам: по нему API считает лимиты входа в админку и пишет аудит.
 *
 * Адрес клиента: `X-Real-IP` (его ставит входной узел хостинга), иначе — последнее значение `X-Forwarded-For`
 * (его дописывает ближайший к нам прокси; первое значение мог прислать сам клиент). Только правильный IP.
 */

export const PROXY_HEADER = "x-pl-proxy";
export const PROXY_IP_HEADER = "x-pl-client-ip";

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-f:.]{2,45}$/i;

export function cleanIp(v: string | null | undefined): string | null {
  const ip = (v ?? "").trim();
  if (!ip) return null;
  return IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip)) ? ip : null;
}

/** Адрес клиента, как его видит прокси сайта. */
export function clientIp(headers: Headers): string | null {
  const real = cleanIp(headers.get("x-real-ip"));
  if (real) return real;
  const chain = (headers.get("x-forwarded-for") ?? "").split(",");
  return cleanIp(chain[chain.length - 1]);
}

/** Заголовки для API: пусто без секрета; с секретом — подпись и адрес клиента (если он известен). */
export function proxyTrust(headers: Headers, secret: string | undefined): Record<string, string> {
  if (!secret) return {};
  const ip = clientIp(headers);
  return ip ? { [PROXY_HEADER]: secret, [PROXY_IP_HEADER]: ip } : { [PROXY_HEADER]: secret };
}
