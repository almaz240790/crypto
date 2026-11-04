"use client";

import type { Timeframe } from "@platform/charts";
import { useImperativeHandle, useRef, type Ref } from "react";
import { Button, Popover, SegmentedControl, usePopover, type SegmentItem } from "@/components/ui";
import { IconLock } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { INTRADAY, TF_LABEL, tfOrder } from "@/lib/timeframes";
import c from "./chrome.module.css";

export type TimeframeBarHandle = {
  /** Открыть окно «Минутные таймфреймы» у сегмента tf (клавиши 1–3 у гостя и на Free). */
  openLocked: (tf: Timeframe) => void;
};

type Props = {
  symbol: string;
  tf: Timeframe;
  /** Минутные ТФ закрыты (гость или Free): они стоят после доступных, с замком, и открывают окно. */
  intradayLocked: boolean;
  guest: boolean;
  ref?: Ref<TimeframeBarHandle>;
};

/**
 * Таймфреймы (план 2B.9, §7): сегменты-ссылки с подписями TF_LABEL («1ч 4ч 1Д 1Н»), prefetch выключен.
 * Закрытый минутный ТФ — кнопка с замком (data-locked): клик открывает окно с объяснением и кнопками
 * «Войти» / «Подписка» вместо перехода на страницу ошибки; адрес не меняется.
 */
export function TimeframeBar({ symbol, tf, intradayLocked, guest, ref }: Props) {
  const t = useT();
  const locked = usePopover();
  const segs = useRef<Partial<Record<Timeframe, HTMLElement>>>({});
  useImperativeHandle(ref, () => ({
    openLocked: (x: Timeframe) => {
      const el = segs.current[x] ?? document.querySelector<HTMLElement>(`[data-tf="${x}"]`);
      if (el && !locked.open) locked.toggle(el);
    },
  }));
  const items: SegmentItem<Timeframe>[] = tfOrder(intradayLocked).map((x) => {
    const closed = intradayLocked && INTRADAY.includes(x);
    if (!closed) return { value: x, label: t(TF_LABEL[x]), href: `/chart/${symbol}/${x}`, attrs: { "data-tf": x } };
    return {
      value: x,
      label: (
        <span className={c.locked}>
          {t(TF_LABEL[x])} <IconLock />
        </span>
      ),
      ariaLabel: t(TF_LABEL[x]),
      title: guest ? t("после входа, подписка Pro") : t("с подпиской Pro"),
      attrs: { "data-tf": x, "data-locked": "true", "aria-haspopup": "dialog", "aria-expanded": locked.open },
    };
  });
  return (
    <>
      <SegmentedControl
        mode="links"
        label={t("таймфрейм")}
        value={tf}
        items={items}
        onSelect={(x, el) => {
          segs.current[x] = el;
          locked.toggle(el);
        }}
      />
      <Popover open={locked.open} onClose={locked.close} anchor={locked.anchor} label={t("Минутные таймфреймы")} id={locked.id} width={300}>
        <p className={c.lockedText}>{guest ? t("1м, 5м и 15м — после входа с подпиской Pro.") : t("1м, 5м и 15м — с подпиской Pro.")}</p>
        <div className={c.actions}>
          {guest ? (
            <>
              <Button variant="primary" size="sm" href={`/login?next=/chart/${symbol}/1m`}>
                {t("Войти")}
              </Button>
              <Button variant="ghost" size="sm" href="/pricing">
                {t("Подписка")}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" href="/billing">
              {t("Подписка")}
            </Button>
          )}
        </div>
      </Popover>
    </>
  );
}
