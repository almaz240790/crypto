import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Картинки главной (public/landing): имя файла содержит начало sha256 содержимого — `phone.ce7c3325.webp`.
 * Cloudflare отдаёт /landing/* с `cache-control: public, max-age=14400`, а HTML главной — без кэша: если заменить
 * картинку под прежним именем, браузер до 4 часов показывает старый снимок рядом с новыми подписями. Новое
 * содержимое — новое имя, тогда кэш не мешает. Тест следит за этим и за тем, что width/height в разметке
 * совпадают с настоящими размерами картинки (пропорции без искажений и без сдвига вёрстки).
 */

const DIR = fileURLToPath(new URL("../../public/landing/", import.meta.url));
const PAGE = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

/** Ширина и высота WebP по заголовку (VP8, VP8L, VP8X). */
function webpSize(buf: Buffer): { width: number; height: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") throw new Error("не WebP");
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  throw new Error(`неизвестный блок WebP: ${chunk}`);
}

/** Теги <img src="/landing/…"> главной: путь и атрибуты width/height. */
const IMGS = [...PAGE.matchAll(/<img\b[^>]*?src="\/landing\/([^"]+)"[^>]*>/g)].map((m) => ({
  file: m[1],
  width: Number(/\bwidth=\{(\d+)\}/.exec(m[0])?.[1]),
  height: Number(/\bheight=\{(\d+)\}/.exec(m[0])?.[1]),
}));

describe("картинки главной", () => {
  it("на странице четыре картинки из public/landing, лишних файлов в папке нет", () => {
    expect(IMGS).toHaveLength(4);
    expect(readdirSync(DIR).sort()).toEqual(IMGS.map((i) => i.file).sort());
  });

  it.each(IMGS)("$file: в имени — начало sha256 содержимого (новый снимок — новое имя, кэш Cloudflare не мешает)", ({ file }) => {
    const m = /^[a-z]+\.([0-9a-f]{8})\.webp$/.exec(file);
    expect(m, `имя ${file} — вида name.<8 hex>.webp`).not.toBeNull();
    const hash = createHash("sha256").update(readFileSync(DIR + file)).digest("hex").slice(0, 8);
    expect(m![1], `переименуйте в ${file.replace(/\.[0-9a-f]{8}\.webp$|\.webp$/, "")}.${hash}.webp`).toBe(hash);
  });

  it.each(IMGS)("$file: width/height в разметке совпадают с размерами картинки или её пропорциями", ({ file, width, height }) => {
    const size = webpSize(readFileSync(DIR + file));
    expect(Number.isFinite(width) && Number.isFinite(height)).toBe(true);
    // phone — снимок @2x: атрибуты в CSS-пикселях телефона (390×844), пропорции те же
    expect(Math.abs(size.width / size.height - width / height)).toBeLessThan(0.002);
  });
});

describe("webpSize", () => {
  it("читает VP8, VP8L и VP8X", () => {
    const riff = (chunk: string, body: number[]) => {
      const b = Buffer.alloc(40);
      b.write("RIFF", 0, "ascii");
      b.write("WEBP", 8, "ascii");
      b.write(chunk, 12, "ascii");
      body.forEach((v, i) => (b[20 + i] = v));
      return b;
    };
    // VP8: ширина и высота — 14 бит по смещению 26 и 28
    const vp8 = riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x84, 0x03, 0x3c, 0x05]);
    expect(webpSize(vp8)).toEqual({ width: 900, height: 1340 });
    // VP8L: байт-подпись 0x2f, затем 14 бит (ширина − 1) и 14 бит (высота − 1)
    const w = 599, h = 1199, bits = w | (h << 14);
    const vp8l = riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]);
    expect(webpSize(vp8l)).toEqual({ width: 600, height: 1200 });
    // VP8X: флаги и 3 резервных байта, затем по 3 байта (ширина − 1) и (высота − 1)
    const vp8x = riff("VP8X", [0, 0, 0, 0, 0xcf, 0x07, 0, 0x1f, 0x05, 0]);
    expect(webpSize(vp8x)).toEqual({ width: 2000, height: 1312 });
  });

  it("не WebP — ошибка", () => {
    expect(() => webpSize(Buffer.from("not a webp file at all, really"))).toThrow();
  });
});
