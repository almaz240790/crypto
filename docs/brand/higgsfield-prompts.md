# Промты для Higgsfield: фото, 3D, видео и логотип PlatformSol

Для главной (ADR-0006). Расположение блоков — по образцу robinhood.com по просьбе владельца, **образы — свои**:
ничего не повторяет их фото и видео (монитор на закате, цепь, телефон на градиенте, «дождь» из линий).

## Идея: «Солнце над рынком»

Sol — солнце. Свет размечает рынок, как PlatformSol размечает график:

- рынок — это **рельеф**, гребень которого повторяет линию цены;
- **уровни** — тонкие световые линии поперёк пейзажа;
- **рисование** — инструменты чертёжника;
- **слои** автоматической разметки — стеклянные пластины;
- **салатовое солнце** — единственный яркий акцент.

Палитра: чёрный #050607, графит #15171A, тёплый светлый камень #D9D6CE, глубокий зелёно-чёрный #0D1310,
салатовый #C6F432.

## Общие правила

- **Без текста, цифр и логотипов на картинках.** Модели искажают буквы; чужие логотипы (Apple, Binance, TradingView)
  использовать нельзя.
- **Экраны планшета и телефона — сплошной ярко-зелёный (#00FF00).** На этот зелёный Fable вставит настоящий
  скриншот нашего графика с правильной перспективой.
- **Без лиц и рук людей.**
- Каждую картинку генерируйте в 4 вариантах, выбирайте лучший и скачивайте в максимальном качестве (PNG или MP4).
  Готовые файлы присылайте в чат.
- **Права:** перед публикацией проверьте, что ваш тариф Higgsfield разрешает коммерческое использование.

**Стиль — добавляйте в конец каждого промта фото и 3D:**

```
quiet premium editorial imagery, minimal, precise, cinematic natural light, deep black and graphite with warm stone tones and a single acid-lime (#C6F432) accent, high detail, no text, no letters, no numbers, no logos, no watermark
```

**Негативный промт (если есть поле «negative»):**

```
text, letters, numbers, logo, watermark, brand names, Apple logo, Binance, TradingView, people, faces, hands, chains, monitors on stands, rain, cyberpunk, neon city, purple, blue neon, oversaturated, clutter, low quality, blurry, distorted
```

---

## 1. Видео первого экрана — «Рассвет над графиком»

Компьютер **16:9** (1920×1080), телефон **9:16** (1080×1920). Длина 6–10 с, бесшовный повтор.
Сначала сгенерируйте картинку, потом сделайте из неё видео (Image to Video).

Картинка:

```
Cinematic aerial view at night over a vast dark volcanic landscape whose mountain ridgeline forms the jagged silhouette of a price chart running from left to right; a small intense acid-lime sun sits low on the horizon behind the ridge and draws a thin rim of light along the ridgeline; three faint horizontal acid-lime light lines cross the whole landscape at different heights, like support and resistance levels; soft mist in the valleys; the upper half of the frame is an empty deep black sky for a headline; minimal, vast, quiet
```

Движение для видео:

```
very slow forward drone flight along the ridge, the lime sun rises slightly, mist drifts, the level lines shimmer faintly, calm, seamless loop, no cuts
```

Для телефона: тот же промт и добавьте `vertical composition, ridge and sun in the lower third`.

## 2. «Стол картографа» (блок «Всё для теханализа»)

Компьютер **16:9** (2880×1620), телефон **3:4** (1170×1560).

```
Top-down flat lay photograph on a dark graphite drafting mat with a fine grid: a frameless tablet lies slightly rotated in the left half of the frame, its screen is solid flat chroma-key green (#00FF00), evenly lit; around it precise drawing instruments — a matte black steel ruler, a clear acrylic set square, a brass compass, a mechanical pencil with an acid-lime clip — and a sheet of tracing paper with hand-drawn straight trend lines and arcs in thin graphite pencil, no numbers; the right half of the frame is empty dark mat for text; soft directional light from the top left, crisp long shadows, editorial still life
```

Для телефона: `vertical composition, tablet and instruments in the lower half, the upper half is empty dark mat`.

## 3. «Слои» (блок «Уровни, зоны и ликвидации — сами»)

Компьютер **16:9**, телефон **3:4**.

```
3D render: five thin frosted glass plates stacked horizontally with even gaps, floating in isometric view in the left half of the frame; each plate carries a different fine etched pattern — parallel horizontal lines, rectangular zones, a zigzag line, scattered small dots, a soft gradient band; a single narrow beam of acid-lime light passes down through the whole stack and projects a sharp lime line shaped like a price chart onto the pale surface below; smooth warm light-stone background (#D9D6CE), soft daylight, delicate shadows, the right half is empty for text, minimal, architectural, premium
```

Для телефона: `vertical composition, the stack in the lower half, the upper half is empty background`.

## 4. «Рассвет» с телефоном (блок «Полноценный график в кармане»)

Компьютер **16:9**, телефон **3:4**.

```
Photorealistic still life at dawn: a modern frameless smartphone with no logos rests at a slight angle on a smooth black basalt stone in calm shallow water, placed in the right half of the frame and cropped by the bottom edge; its screen is solid flat chroma-key green (#00FF00); far behind, a small acid-lime sun is rising over a flat horizon and leaves a thin glowing line on the water; the sky fades from black at the top to deep green-grey near the horizon; the left half of the frame is empty for text; calm, minimal, cinematic
```

## 5. Четыре рисунка для блока «Честный инструмент без перерисовки»

Квадрат **1:1** (1024×1024). Начало промта одинаковое, конец — свой для каждого рисунка.

```
Minimal isometric line illustration, single hairline warm off-white stroke (#F1EFE8) on a flat deep green-black background (#0D1310), no fill, no shading, centered, generous empty margins, elegant technical drawing,
```

- **а)** `three isometric candlestick bars of different heights with thin wicks standing on a baseline`
- **б)** `a stack of three isometric discs like a database, with a small arrow leaving to the right`
- **в)** `concentric broken rings forming an abstract lock dial with a small cross in the center`
- **г)** `a magnifying glass over a small line chart with a light grid`

Сейчас на сайте стоят нарисованные Fable векторные версии. Эти промты нужны, только если захотите живее.

## 6. Видео финального блока — «Восход»

Компьютер **16:9**, телефон **9:16**. Длина 8 с, бесшовный повтор.

```
Minimal abstract animation: a perfect acid-lime sun slowly rises from behind a thin straight horizon line at the bottom center of a pure black frame; as it rises, faint thin horizontal lines appear across the black sky at different heights, like price levels, and gently fade; soft glow, lots of empty black space in the center for a headline; seamless loop
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

**1200×630.** Fable соберёт её сам из кадра первого экрана и логотипа.

---

## Куда что встанет

| № | Файл | Место на сайте |
|---|---|---|
| 1 | видео 16:9 и 9:16 | фон первого экрана под заголовком «Технический анализ в одном окне» |
| 2 | фото 16:9 и 3:4 | блок «Всё для теханализа» — на экран планшета встанет мультичарт |
| 3 | 3D 16:9 и 3:4 | блок «Уровни, зоны и ликвидации — сами» |
| 4 | фото 16:9 и 3:4 | блок «Полноценный график в кармане» — на экран встанет наш график с телефона |
| 5 | 4 рисунка 1:1 | блок «Честный инструмент без перерисовки» |
| 6 | видео 16:9 и 9:16 | фон финального блока |
| 7 | эскиз логотипа | шапка, подвал, значок вкладки, иконка на телефоне |
