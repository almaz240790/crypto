"use client";

import { TOOL_TITLES } from "@platform/charts";
import { useT } from "@/i18n/client";
import { TF_LABEL, TIMEFRAMES } from "@/lib/timeframes";
import c from "./chrome.module.css";

/**
 * «Горячие клавиши» из «⋯ Ещё» (план 2B.9, §3.3): клавиши терминала одним списком. Цифры 1–7 — по TIMEFRAMES
 * (§7), поэтому у каждой цифры подписан её таймфрейм: у гостя закрытые минутные стоят в ряду последними.
 */
export function Hotkeys() {
  const t = useT();
  const rows: [string, string][] = [
    ["Alt+H", t(TOOL_TITLES.hline)],
    ["Alt+T", t(TOOL_TITLES.trend)],
    ["Ctrl+Z", t("отменить")],
    ["Ctrl+Y", t("повторить")],
    ["Del", t("удалить выбранный рисунок")],
    ["+ / −", t("приблизить / отдалить")],
    ["Esc", t("снять выбор, закончить рисование")],
  ];
  return (
    <div className={c.hotkeys}>
      <strong>{t("Горячие клавиши")}</strong>
      <dl>
        <div className={c.hotkeyRow}>
          <dt>
            <kbd>1–7</kbd>
          </dt>
          <dd className={c.hotkeyTfs}>
            {TIMEFRAMES.map((tf, i) => (
              <span key={tf}>
                <kbd>{i + 1}</kbd> {t(TF_LABEL[tf])}
              </span>
            ))}
          </dd>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className={c.hotkeyRow}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
