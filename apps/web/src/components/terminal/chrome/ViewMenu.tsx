"use client";

import { CHART_TYPES, type ChartType, type ScaleMode } from "@platform/charts";
import { Button, Popover, Select, usePopover } from "@/components/ui";
import { IconChevronDown, IconView } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { useSignalsAccess } from "@/components/auth/signalsAccess";
import type { Instrument } from "@/lib/user";
import { SCALE_LABEL, TYPE_LABEL } from "./labels";
import c from "./chrome.module.css";

type Props = {
  symbol: string;
  type: ChartType;
  scale: ScaleMode;
  overlay: string | null;
  instruments: readonly Instrument[];
  onType: (t: ChartType) => void;
  onScale: (s: ScaleMode) => void;
  /** Наложение второго инструмента; при включении линейная шкала переходит в проценты (как раньше). */
  onOverlay: (symbol: string | null) => void;
};

/**
 * «Вид» (план 2B.9, §3.3): тип графика, шкала и наложение второго инструмента в одном окне у кнопки.
 * Это popover (role=dialog), а не меню: внутри нативные списки. В компактном тулбаре — только иконка.
 */
export function ViewMenu({ symbol, type, scale, overlay, instruments, onType, onScale, onOverlay }: Props) {
  const t = useT();
  const { open: signals } = useSignalsAccess();
  const view = usePopover();
  return (
    <>
      <Button {...view.triggerProps} variant="ghost" aria-label={t("Вид")} title={t("Тип графика, шкала и наложение")}>
        <IconView />
        <span data-ov-extra>{t("Вид")}</span>
        <span data-ov-extra>
          <IconChevronDown />
        </span>
      </Button>
      <Popover open={view.open} onClose={view.close} anchor={view.anchor} label={t("Вид")} id={view.id} width={280}>
        <div className={c.viewBody}>
          <div>
            <Select label={t("Тип графика")} aria-label={t("тип графика")} value={type} onChange={(e) => onType(e.target.value as ChartType)}>
              {CHART_TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(TYPE_LABEL[x])}
                </option>
              ))}
            </Select>
            {type === "heikin" && <p className={c.hint}>{signals ? t("Паттерны и сигналы считаются по обычным свечам") : t("Паттерны считаются по обычным свечам")}</p>}
          </div>
          <Select label={t("Шкала")} aria-label={t("шкала")} value={scale} onChange={(e) => onScale(e.target.value as ScaleMode)}>
            {(Object.keys(SCALE_LABEL) as ScaleMode[]).map((m) => (
              <option key={m} value={m}>
                {t(SCALE_LABEL[m])}
              </option>
            ))}
          </Select>
          <Select label={t("Наложение")} aria-label={t("наложение")} value={overlay ?? ""} onChange={(e) => onOverlay(e.target.value || null)} title={t("Наложить второй инструмент (линия закрытий)")}>
            <option value="">{t("без наложения")}</option>
            {instruments
              .filter((i) => i.symbol !== symbol)
              .map((i) => (
                <option key={i.symbol} value={i.symbol}>
                  + {i.symbol}
                </option>
              ))}
          </Select>
        </div>
      </Popover>
    </>
  );
}
