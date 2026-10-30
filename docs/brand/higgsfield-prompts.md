# Промты для Higgsfield: фото, 3D, видео и логотип PlatformSol

Для главной (сетка по образцу robinhood.com, ADR-0006). Промты на английском: модели понимают его лучше.
Каждый файл генерируйте в 4 вариантах, выбирайте лучший и скачивайте в максимальном качестве (PNG или MP4).
Готовые файлы присылайте в чат — сайт под них подстроит Fable.

## Общие правила

- **Без текста, цифр и логотипов на картинках.** Модели искажают буквы; чужие логотипы (Apple, Binance, TradingView)
  использовать нельзя.
- **Экраны монитора и телефона — сплошной ярко-зелёный (#00FF00).** На этот зелёный Fable вставит настоящий скриншот
  нашего графика с правильной перспективой.
- **Без лиц людей**, чтобы не было вопросов о правах на внешность.
- **Права:** перед публикацией проверьте, что ваш тариф Higgsfield разрешает коммерческое использование.
- **Цвета бренда:** чёрный #050607, салатовый #C6F432, графит, тёмно-оливковый #1B190F, серо-голубой #A9B6C8.

**Стиль — добавляйте в конец каждого промта фото и 3D:**

```
premium fintech brand imagery, minimal, cinematic soft light, deep black and graphite tones with a single acid-lime (#C6F432) accent, high detail, no text, no letters, no numbers, no logos, no watermark
```

**Негативный промт (если есть поле «negative»):**

```
text, letters, numbers, logo, watermark, brand names, Apple logo, Binance, TradingView, people, faces, hands, extra fingers, clutter, cyberpunk, purple, blue neon, oversaturated, low quality, blurry, distorted
```

---

## 1. Видео первого экрана (фон под заголовком)

Компьютер **16:9** (1920×1080), телефон **9:16** (1080×1920). Длина 6–10 с, бесшовный повтор.
Сначала сгенерируйте картинку, потом сделайте из неё видео (Image to Video).

Картинка:

```
Abstract 3D scene in pure black space: a single glowing acid-lime light trail draws the silhouette of a rising and falling price chart from left to right across the lower half of the frame, thin and elegant like a neon filament, soft bloom, faint reflection on a black glossy floor, tiny floating dust particles, the whole upper half of the frame is empty black space for a headline, minimal, cinematic
```

Движение для видео:

```
slow camera dolly forward, the lime light line keeps drawing itself from left to right and flowing, particles drift gently, calm and premium, seamless loop, no cuts
```

Для телефона: тот же промт и добавьте `vertical composition, chart line in the lower third`.

## 2. Монитор на закате (блок «Всё для теханализа»)

Компьютер **16:9** (2880×1620), телефон **3:4** (1170×1560).

```
Photorealistic product photo: a sleek frameless desktop monitor on a slim graphite stand standing on a dark matte concrete ledge, monitor turned about 30 degrees to the right, placed in the left half of the frame; the screen is solid flat chroma-key green (#00FF00), evenly lit, no reflections; background is a calm dusk sky with soft warm-grey clouds fading to deep graphite at the top; the ledge runs diagonally across the bottom of the frame; the right half of the frame is empty sky for text; shallow depth of field, cinematic, minimal
```

Для телефона: `vertical composition, monitor in the lower half, the upper 45% is empty sky for text`.

## 3. 3D-свечи из хрома (блок «Уровни, зоны и ликвидации — сами»)

Компьютер **16:9**, телефон **3:4**.

```
3D render: a sculptural arrangement of five polished chrome candlestick bars of different heights with thin chrome wicks, floating at a slight angle, one bar made of frosted acid-lime glass (#C6F432) glowing softly from inside, placed in the left 45% of the frame and partly cropped by the left and bottom edges; smooth matte slate blue-grey background (gradient #A9B6C8 to #C3CDDB), soft studio light, gentle shadows, the right half is empty for text, minimal, premium, octane render
```

Для телефона: `vertical composition, object in the lower half, the upper half is empty background`.

## 4. Телефон (блок «Полноценный график в кармане»)

Компьютер **16:9**, телефон **3:4**.

```
Photorealistic 3D render of a modern frameless smartphone with no logos and no buttons visible, tilted about 15 degrees, standing on the right side of the frame and cropped by the bottom edge; the screen is solid flat chroma-key green (#00FF00); background is a vertical gradient from pure black at the top to cool blue-grey at the bottom; soft rim light along the phone edges, subtle reflection; the left half of the frame is empty for text; minimal, premium
```

## 5. Четыре рисунка для блока «Честный инструмент без перерисовки»

Квадрат **1:1** (1024×1024). Начало промта одинаковое, конец — свой для каждого рисунка.

```
Minimal isometric line illustration, single hairline off-white stroke (#F1EFE8) on flat dark olive background (#1B190F), no fill, no shading, centered, generous empty margins, elegant technical drawing,
```

- **а)** `three isometric candlestick bars of different heights with thin wicks standing on a baseline`
- **б)** `a stack of three isometric discs like a database, with a small arrow leaving to the right`
- **в)** `concentric broken rings forming an abstract lock dial with a small cross in the center`
- **г)** `a magnifying glass over a small line chart with a light grid`

Сейчас на сайте стоят нарисованные Fable векторные версии. Эти промты нужны, только если захотите живее.

## 6. Видео финального блока («Откройте график прямо сейчас»)

Компьютер **16:9**, телефон **9:16**. Длина 8 с, бесшовный повтор.

```
Pure black background filled with many thin white vertical hairlines of different lengths, like candlestick wicks, scattered evenly across the whole frame; they slowly rise and fall at different speeds, a few of them briefly glow acid-lime (#C6F432); very subtle and elegant, the center of the frame slightly darker for a headline; seamless loop
```

## 7. Логотип — три направления

Квадрат **1:1** (2048×2048). AI даёт только эскиз. Выберите понравившийся, а Fable перерисует его в чистый вектор
(SVG) для сайта, иконки приложения и значка во вкладке браузера.

Начало промта для всех трёх:

```
Flat vector logo mark, geometric, minimal, bold, no text, no letters, centered on a plain white background, single color black, high contrast, must stay readable as a 16px favicon and as an app icon, Swiss design,
```

- **А. «Солнце и фитиль»** (Sol — солнце, свеча — график):
  `a solid circle (the sun) pierced by one vertical candlestick wick through its center, the lower half of the circle filled, the upper half outlined`
- **Б. Буква S из свечей:**
  `the letter S built from two rounded rectangular candlestick bodies offset diagonally, connected by a thin vertical wick`
- **В. Восход над горизонтом:**
  `a rising sun made of three horizontal bars of increasing width above a thin horizon line, a small circle on top`

Понравившийся вариант повторите в цвете: тот же промт, замените конец на
`acid-lime (#C6F432) mark on pure black background`.

## 8. Картинка для ссылок в соцсетях и мессенджерах (по желанию)

**1200×630.** Fable может собрать её сам из кадра первого экрана и логотипа, отдельный промт не обязателен.

---

## Куда что встанет

| № | Файл | Место на сайте |
|---|---|---|
| 1 | видео 16:9 и 9:16 | фон первого экрана под заголовком «Технический анализ в одном окне» |
| 2 | фото 16:9 и 3:4 | блок «Всё для теханализа» — на экран монитора встанет мультичарт |
| 3 | 3D 16:9 и 3:4 | блок «Уровни, зоны и ликвидации — сами» |
| 4 | 3D 16:9 и 3:4 | блок «Полноценный график в кармане» — на экран встанет наш график с телефона |
| 5 | 4 рисунка 1:1 | блок «Честный инструмент без перерисовки» |
| 6 | видео 16:9 и 9:16 | фон финального блока |
| 7 | эскиз логотипа | шапка, подвал, значок вкладки, иконка на телефоне |
