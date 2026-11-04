"use client";

import { memo, useState } from "react";
import { Button, IconButton, Input } from "@/components/ui";
import { IconClose } from "@/components/ui/icons";
import { useT } from "@/i18n/client";
import { TEMPLATES } from "../templates";
import p from "./panels.module.css";

type Props = {
  layouts: readonly { name: string }[];
  onTemplate: (id: string) => void;
  onSave: (name: string) => void;
  onLoad: (name: string) => void;
  onDelete: (name: string) => void;
  authed: boolean;
  /** Лимит именованных раскладок по подписке (гостю 0); null — без лимита. */
  limit: number | null;
};

/** «Раскладки» (план 2B.9 §8.2): наборы индикаторов (TEMPLATES) и мои раскладки — применить, удалить, сохранить текущую. */
export const LayoutsTab = memo(function LayoutsTab({ layouts, onTemplate, onSave, onLoad, onDelete, authed, limit }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  return (
    <div className={p.tab}>
      <section className={p.group} aria-label={t("Наборы индикаторов")}>
        <strong className={p.groupHead}>{t("Наборы индикаторов")}</strong>
        <div className={p.chips}>
          {TEMPLATES.map((tpl) => (
            <Button key={tpl.id} size="sm" onClick={() => onTemplate(tpl.id)}>
              {t(tpl.title)}
            </Button>
          ))}
        </div>
      </section>
      <section className={p.group} aria-label={t("Мои раскладки")}>
        <strong className={p.groupHead}>{t("Мои раскладки")}</strong>
        {!authed && <p className={p.empty}>{t("Войдите, чтобы сохранять раскладки.")}</p>}
        {layouts.length > 0 && (
          <ul className={p.rows}>
            {layouts.map((l) => (
              <li key={l.name} className={p.row}>
                <button type="button" className={p.rowMain} onClick={() => onLoad(l.name)}>
                  <span className={p.rowText}>{l.name}</span>
                </button>
                <IconButton size="sm" label={t("удалить раскладку {name}", { name: l.name })} onClick={() => onDelete(l.name)}>
                  <IconClose />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {authed && (
          <form
            className={p.save}
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) {
                onSave(name.trim());
                setName("");
              }
            }}
          >
            <Input aria-label={t("имя раскладки")} placeholder={t("имя раскладки")} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" size="sm" disabled={!name.trim() || (limit !== null && layouts.length >= limit)}>
              {t("Сохранить")}
            </Button>
          </form>
        )}
        {authed && limit !== null && <p className={p.note}>{t("лимит подписки: {n}", { n: limit })}</p>}
      </section>
    </div>
  );
});
