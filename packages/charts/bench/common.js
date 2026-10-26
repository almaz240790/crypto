// Общие данные и измерение кадров для прототипов 2B.1 (LWC и KLineChart).
export function makeCandles(n, seed = 42) {
  let x = seed;
  const rnd = () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const out = [];
  let price = 50000;
  let t = Math.floor(Date.now() / 1000) - n * 14400;
  for (let i = 0; i < n; i++) {
    const o = price;
    const c = o * (1 + (rnd() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + rnd() * 0.01);
    const l = Math.min(o, c) * (1 - rnd() * 0.01);
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: 100 + rnd() * 900 });
    price = c;
    t += 14400;
  }
  return out;
}

export function rsi(candles, period = 14) {
  const out = [];
  let gain = 0, loss = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) { gain += g; loss += l; if (i === period) { out.push({ time: candles[i].time, value: 100 - 100 / (1 + gain / (loss || 1e-9)) }); } continue; }
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out.push({ time: candles[i].time, value: 100 - 100 / (1 + gain / (loss || 1e-9)) });
  }
  return out;
}

/** Собирает длительности кадров через rAF; window.__frames — массив мс. */
export function startFrameMeter() {
  const frames = [];
  let last = performance.now();
  function tick(now) {
    frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__frames = frames;
  window.__resetFrames = () => { frames.length = 0; last = performance.now(); };
}
