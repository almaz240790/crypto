"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/tools/tools.module.css";
import { Button, Input, Panel } from "@/components/ui";
import { createTicket, getMyTickets, type Ticket } from "@/lib/support";
import { formatTimeUTC } from "@/lib/format";

const STATUS: Record<Ticket["status"], string> = { open: "открыто", answered: "есть ответ", closed: "закрыто" };

function Inner() {
  const { user } = useAuth();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState(params.get("subject") ?? "");
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(params.get("page") ?? "");
  const [done, setDone] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Ticket[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!page && typeof document !== "undefined" && document.referrer) {
      try {
        const u = new URL(document.referrer);
        if (u.origin === window.location.origin) queueMicrotask(() => setPage(u.pathname));
      } catch {
        /* ignore */
      }
    }
  }, [page]);
  useEffect(() => {
    if (user)
      getMyTickets()
        .then((r) => setMine(r))
        .catch(() => setMine([]));
  }, [user, done]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const t = await createTicket({ email: user ? undefined : email, subject, message, page: page || null, version: process.env.NEXT_PUBLIC_APP_VERSION ?? null }, !!user);
      setDone(t);
      setSubject("");
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ошибка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Panel title="Написать в поддержку">
        {done ? (
          <p role="status">
            Обращение #{done.id} принято. Ответ придёт на {done.email}, обычно в течение суток.{" "}
            <button type="button" className={s.small} onClick={() => setDone(null)}>
              написать ещё
            </button>
          </p>
        ) : (
          <form className={s.form} onSubmit={submit}>
            {error && (
              <p className={s.toast} data-kind="error" role="alert">
                {error}
              </p>
            )}
            {!user && <Input label="Email для ответа" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />}
            <Input label="Тема" value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} maxLength={200} />
            <label style={{ display: "grid", gap: 4 }}>
              <span className="caption">Сообщение</span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} required minLength={10} maxLength={5000} rows={6} aria-label="Сообщение" style={{ font: "inherit", padding: 8, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg)", color: "var(--text)" }} />
            </label>
            <Input label="Страница (прикрепляется сама)" value={page} onChange={(e) => setPage(e.target.value)} maxLength={300} hint={`версия ${process.env.NEXT_PUBLIC_APP_VERSION ?? "—"}${user ? ", тариф прикрепится автоматически" : ""}`} />
            <div className={s.actions}>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Отправить
              </Button>
            </div>
          </form>
        )}
      </Panel>
      {user && mine && mine.length > 0 && (
        <Panel title="Мои обращения" flush>
          <ul style={{ margin: 0, padding: "8px 16px", listStyle: "none", display: "grid", gap: 8 }}>
            {mine.map((t) => (
              <li key={t.id} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                <strong>#{t.id}</strong> {t.subject} <span className="caption">{t.created_at ? formatTimeUTC(t.created_at) : ""}</span> · <span className="text-2">{STATUS[t.status]}</span>
                {t.reply && (
                  <p className="text-2" style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                    {t.reply}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

export function SupportForm() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
