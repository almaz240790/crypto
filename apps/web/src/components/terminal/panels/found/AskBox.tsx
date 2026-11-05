"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { askChart, type Explanation } from "@/lib/chart";
import type { Timeframe } from "@/lib/timeframes";
import { useT } from "@/i18n/client";
import s from "../../terminal.module.css";
import p from "../panels.module.css";

/** Готовые вопросы: человеку без опыта проще начать с примера. */
const ASK_EXAMPLES = [
  "Какой сейчас тренд на старших таймфреймах?",
  "Где ближайшая зона и далеко ли до неё цена?",
  "Что за паттерн на последних свечах и как он отрабатывал раньше?",
  "Где проходят важные уровни выше и ниже цены?",
];
/** Ответы-заглушки сервера (нет тарифа, выключено, лимит) — показываем как уведомление, а не как ответ. */
const ASK_NOTICE = new Set(["plan", "disabled", "limit", "budget", "empty"]);

/**
 * Вопрос о графике (план 2A.10.3, 4B.7): Premium; текст ≤ 500 символов уходит как данные.
 * access: null — ещё неизвестно, "guest" — не вошёл, "plan" — тариф ниже Premium, "ok" — можно спрашивать.
 * compact — свой небольшой блок в конце «Найдено» (план 2B.9 §8.1): гостю одна строка со ссылкой, готовые
 * вопросы свёрнуты; без compact — лист «Вопрос о графике» на телефоне (как раньше).
 */
export function AskBox({ symbol, tf, access, heading = true, compact = false }: { symbol: string; tf: Timeframe; access: "guest" | "plan" | "ok" | null; heading?: boolean; compact?: boolean }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [state, setState] = useState<Explanation | "loading" | { error: string } | null>(null);
  const answerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state && state !== "loading") answerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state]);
  const send = (question: string) => {
    const text = question.trim().slice(0, 500);
    if (!text) return;
    setQ(text);
    setState("loading");
    askChart(symbol, tf, text)
      .then((r) => setState(r))
      .catch((err: Error) => setState({ error: err.message }));
  };
  const cls = compact ? `${s.ask} ${p.askCompact}` : s.ask;
  if (access === "guest")
    return compact ? (
      <p className={p.askLine}>
        <Link href={`/login?next=/chart/${symbol}/${tf}`}>{t("Войдите")}</Link>, {t("чтобы задавать вопросы о графике.")}
      </p>
    ) : (
      <div className={cls}>
        {heading && <strong>{t("Вопрос о графике")}</strong>}
        <p className={s.askNote}>
          <Link href="/login">{t("Войдите")}</Link>, {t("чтобы задавать вопросы о графике.")}
        </p>
      </div>
    );
  if (access === "plan")
    return (
      <div className={cls}>
        {heading && <strong>{t("Вопрос о графике")}</strong>}
        <p className={s.askNote}>
          {t("Вопросы о графике доступны с подпиской Premium: ответ составляется только по данным этого графика — тренд, зоны, уровни, паттерны.")}{" "}
          <Link href="/billing">{t("Подписка")}</Link>
        </p>
      </div>
    );
  const busy = state === "loading";
  const notice = state !== null && typeof state === "object" && "text" in state && state.source === "template" && ASK_NOTICE.has(state.reason ?? "");
  const examples = (
    <div className={s.askExamples}>
      {ASK_EXAMPLES.map((x) => (
        <button key={x} type="button" className={s.askExample} disabled={busy} onClick={() => send(t(x))}>
          {t(x)}
        </button>
      ))}
    </div>
  );
  return (
    <form
      className={cls}
      onSubmit={(e) => {
        e.preventDefault();
        send(q);
      }}
      aria-label={t("вопрос о графике")}
    >
      {heading && <strong>{t("Вопрос о графике")}</strong>}
      {compact ? (
        <details className={p.askExamples}>
          <summary>{t("Готовые вопросы")}</summary>
          {examples}
        </details>
      ) : (
        examples
      )}
      <textarea aria-label={t("текст вопроса")} maxLength={500} rows={2} placeholder={t("или напишите свой вопрос")} value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="submit" className={s.askSubmit} disabled={busy || !q.trim()}>
        {busy ? t("Составляю ответ…") : t("Спросить")}
      </button>
      <span className="caption">{t("Только по данным графика: без рекомендаций и прогнозов.")}</span>
      <div ref={answerRef} aria-live="polite">
        {busy && <p className={s.askNote}>{t("составляю ответ по данным графика…")}</p>}
        {state !== null && typeof state === "object" && "error" in state && <p className={s.askError}>{state.error}</p>}
        {state !== null && typeof state === "object" && "text" in state && (
          <div data-testid="ask-answer" className={notice ? s.askNote : s.askAnswer}>
            <p>{state.text}</p>
            {!notice && (
              <p className="caption">
                {state.footer}
                {state.source === "template" ? "" : t(" Ответ прошёл проверку: все числа — из данных графика.")}
              </p>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
