"use client";

import { TOOL_TITLES, type Drawing } from "@platform/charts";
import { memo } from "react";
import { Button, IconButton } from "@/components/ui";
import { IconClose, IconLock } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { TF_LABEL } from "@/lib/timeframes";
import { ToolIcon } from "../ToolIcon";
import p from "./panels.module.css";

type Props = {
  drawings: readonly Drawing[];
  selectedId: string | null;
  /** «синхронизировано» / «в очереди» / «ошибка синхронизации» (вошедшим), иначе null. */
  sync: string | null;
  onSelect: (id: string | null) => void;
  onLock: (id: string) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
};

/**
 * «Рисунки» (план 2B.9 §8.2): в шапке — число рисунков, статус синхронизации и «удалить все» (с подтверждением);
 * строки — значок инструмента, название и подпись, таймфрейм («все ТФ» / «4ч»), заблокировать и удалить.
 */
export const DrawingsList = memo(function DrawingsList({ drawings, selectedId, sync, onSelect, onLock, onRemove, onClearAll }: Props) {
  const t = useT();
  return (
    <div className={p.tab}>
      <div className={p.tabHead}>
        <span>{t("рисунков: {n}", { n: drawings.length })}</span>
        {sync && <span className={p.sync}>{sync}</span>}
        {drawings.length > 0 && (
          <Button size="sm" variant="danger" className={p.headAction} onClick={onClearAll}>
            {t("удалить все")}
          </Button>
        )}
      </div>
      {drawings.length === 0 ? (
        <p className={p.empty}>{t("Рисунков нет. Alt+H — линия, Alt+T — трендовая.")}</p>
      ) : (
        <ul className={p.rows}>
          {drawings.map((d) => {
            const name = t(TOOL_TITLES[d.type]);
            return (
              <li key={d.id} className={p.row} data-selected={d.id === selectedId || undefined}>
                <button type="button" className={p.rowMain} onClick={() => onSelect(d.id)}>
                  <span className={p.rowIcon} aria-hidden="true">
                    <ToolIcon name={d.type} />
                  </span>
                  <span className={p.rowText}>
                    {name}
                    {d.text ? ` · ${d.text}` : ""}
                  </span>
                  <span className={p.rowTf}>{d.timeframe ? t(TF_LABEL[d.timeframe as keyof typeof TF_LABEL] ?? d.timeframe) : t("все ТФ")}</span>
                </button>
                <IconButton size="sm" label={`${d.locked ? t("разблокировать") : t("заблокировать")} ${name}`} title={d.locked ? t("Разблокировать") : t("Заблокировать")} pressed={d.locked} onClick={() => onLock(d.id)}>
                  <IconLock />
                </IconButton>
                <IconButton size="sm" label={t("удалить {name}", { name })} title={t("Удалить")} disabled={d.locked} onClick={() => onRemove(d.id)}>
                  <IconClose />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
