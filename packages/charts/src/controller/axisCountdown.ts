import type { Rect } from "../layout/types";

/**
 * Отсчёт до закрытия свечи под ценой на шкале (план 2A.7, ADR-0008) — DOM-зеркало, а не метка LWC:
 * requestUpdate примитива в LWC 5.2.1 — полная перерисовка всех панелей и шкал, и раз в секунду это стоило
 * ~15 мс скрипта на телефоне. Элемент лежит над шкалой (pointer-events: none), y берёт из места «countdown»
 * в раскладке шкалы (деления под ним пустые), двигается только при смене y; текст меняет таймер 1 Гц.
 * Цвета — переменные --chart-*: смена темы перекрашивает его без участия контроллера.
 */
export class AxisCountdown {
  readonly el: HTMLDivElement;
  private rect: Rect | null = null;
  private up = true;
  private text = "";
  private font = "";

  constructor(host: HTMLElement) {
    const el = host.ownerDocument.createElement("div");
    el.dataset.testid = "countdown";
    el.setAttribute("aria-hidden", "true");
    const st = el.style;
    st.position = "absolute";
    st.pointerEvents = "none";
    st.zIndex = "3";
    st.boxSizing = "border-box";
    st.paddingLeft = "8px";
    st.whiteSpace = "nowrap";
    st.overflow = "hidden";
    st.fontFamily = "var(--font-mono)";
    st.fontVariantNumeric = "tabular-nums";
    st.color = "var(--chart-plaque)";
    st.display = "none";
    host.appendChild(el);
    this.el = el;
  }

  /** Место на шкале (координаты контейнера графика, CSS px) и направление последней свечи; null — скрыть. */
  place(rect: Rect | null, up: boolean, fontPx: number): void {
    const st = this.el.style;
    if (!rect || !this.text) {
      if (this.rect !== null || st.display !== "none") st.display = "none";
      this.rect = null;
      return;
    }
    const same = this.rect && this.rect.x === rect.x && this.rect.y === rect.y && this.rect.w === rect.w && this.rect.h === rect.h;
    if (!same) {
      st.left = `${rect.x}px`;
      st.top = `${rect.y}px`;
      st.width = `${rect.w}px`;
      st.height = `${rect.h}px`;
      st.lineHeight = `${rect.h}px`;
      this.rect = rect;
    }
    const font = `${fontPx}px`;
    if (font !== this.font) {
      st.fontSize = font;
      this.font = font;
    }
    if (up !== this.up || st.display === "none") {
      st.background = up ? "var(--chart-up)" : "var(--chart-down)";
      this.up = up;
    }
    st.display = "block";
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.el.textContent = text;
    if (!text) this.el.style.display = "none";
  }

  get shown(): Rect | null {
    return this.el.style.display === "none" ? null : this.rect;
  }

  destroy(): void {
    this.el.remove();
  }
}
