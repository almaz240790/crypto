"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/app/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import s from "@/components/tools/tools.module.css";
import { NotificationsPanel } from "@/components/settings/Notifications";
import { applyTheme } from "@/components/ui/ThemeToggle";
import { Button, EmptyState, Input, Panel, Select } from "@/components/ui";
import { patchProfile, patchRisk, pwnedCount } from "@/lib/auth-client";
import { changePassword, deleteAccount, exportData, getIdentities } from "@/lib/user";

const TZ = ["UTC", "Europe/Moscow", "Europe/Kyiv", "Europe/Berlin", "Europe/London", "Asia/Almaty", "Asia/Tashkent", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "America/New_York", "America/Los_Angeles"];

export default function SettingsPage() {
  const router = useRouter();
  const { user, reload, logout } = useAuth();
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [identities, setIdentities] = useState<{ provider: string; label: string }[]>([]);
  const [profile, setProfile] = useState<Record<string, string> | null>(null);
  const [risk, setRisk] = useState<Record<string, string> | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [confirmEmail, setConfirmEmail] = useState("");

  useEffect(() => {
    getIdentities().then(setIdentities).catch(() => {});
  }, []);

  const p = (k: string) => profile?.[k] ?? ((user as unknown as Record<string, string | null>)?.[k] ?? "") ?? "";
  const r = (k: string) => risk?.[k] ?? String((user?.risk as Record<string, unknown> | undefined)?.[k] ?? "");
  const note = (text: string, kind: "ok" | "error" = "ok") => {
    setMsg({ text, kind });
    setTimeout(() => setMsg(null), 4000);
  };

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      const theme = p("theme") as "light" | "dark" | "system";
      await patchProfile({ name: p("name") || null, locale: p("locale"), timezone: p("timezone"), theme });
      applyTheme(theme);
      await reload();
      setProfile(null);
      note("Профиль сохранён");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }

  async function saveRisk(e: FormEvent) {
    e.preventDefault();
    try {
      const body: Record<string, unknown> = {
        risk_pct: Number(String(r("risk_pct")).replace(",", ".")),
        exchange: r("exchange"),
        market_type: r("market_type"),
        default_leverage: Number(r("default_leverage")) || 1,
      };
      const dep = String(r("deposit")).trim();
      if (dep) body.deposit = dep.replace(",", ".");
      await patchRisk(body as never);
      await reload();
      setRisk(null);
      note("Риск-профиль сохранён");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    try {
      if (pw.next.length < 10) throw new Error("новый пароль короче 10 символов");
      const n = await pwnedCount(pw.next);
      if (n && n > 0) throw new Error("этот пароль встречается в утечках");
      await changePassword(pw.current || null, pw.next);
      setPw({ current: "", next: "" });
      note("Пароль изменён");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }

  async function download() {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "platform-data.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!user) {
    return (
      <AppShell title="Настройки">
        <Panel>
          <EmptyState text="Загрузка профиля…" />
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell title="Настройки">
      <div className={s.wrap}>
        {msg && (
          <p className={s.toast} data-kind={msg.kind} role="status">
            {msg.text}
          </p>
        )}
        <div className={s.two}>
          <Panel title="Профиль">
            <form className={s.form} onSubmit={saveProfile}>
              <Input label="Email" value={user.email} disabled hint={user.email_verified ? "подтверждён" : "не подтверждён — проверьте почту"} />
              <Input label="Имя" value={p("name")} onChange={(e) => setProfile((x) => ({ ...(x ?? {}), name: e.target.value }))} maxLength={100} />
              <div className={s.row}>
                <Select label="Тема" value={p("theme") || "system"} onChange={(e) => setProfile((x) => ({ ...(x ?? {}), theme: e.target.value }))}>
                  <option value="system">как в системе</option>
                  <option value="light">светлая</option>
                  <option value="dark">тёмная</option>
                </Select>
                <Select label="Язык" value={p("locale") || "ru"} onChange={(e) => setProfile((x) => ({ ...(x ?? {}), locale: e.target.value }))}>
                  <option value="ru">русский</option>
                  <option value="en">English (скоро)</option>
                </Select>
                <Select label="Часовой пояс" value={p("timezone") || "UTC"} onChange={(e) => setProfile((x) => ({ ...(x ?? {}), timezone: e.target.value }))}>
                  {TZ.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={s.actions}>
                <Button type="submit" size="sm" variant="primary" disabled={!profile}>
                  Сохранить профиль
                </Button>
              </div>
            </form>
          </Panel>
          <Panel title="Риск-профиль" footer="Используется калькулятором и карточкой сигнала. Депозит хранится только если вы его указали.">
            <form className={s.form} onSubmit={saveRisk}>
              <div className={s.row}>
                <Input label="Депозит, USDT" mono inputMode="decimal" value={r("deposit") === "null" ? "" : r("deposit")} onChange={(e) => setRisk((x) => ({ ...(x ?? {}), deposit: e.target.value }))} placeholder="—" />
                <Input label="Риск на сделку, %" mono inputMode="decimal" value={r("risk_pct")} onChange={(e) => setRisk((x) => ({ ...(x ?? {}), risk_pct: e.target.value }))} />
                <Input label="Плечо по умолчанию" mono inputMode="numeric" value={r("default_leverage")} onChange={(e) => setRisk((x) => ({ ...(x ?? {}), default_leverage: e.target.value }))} />
              </div>
              <div className={s.row}>
                <Select label="Биржа" value={r("exchange") || "binance"} onChange={(e) => setRisk((x) => ({ ...(x ?? {}), exchange: e.target.value }))}>
                  <option value="binance">Binance</option>
                  <option value="bybit">Bybit</option>
                </Select>
                <Select label="Рынок" value={r("market_type") || "futures"} onChange={(e) => setRisk((x) => ({ ...(x ?? {}), market_type: e.target.value }))}>
                  <option value="futures">фьючерсы</option>
                  <option value="spot">спот</option>
                </Select>
              </div>
              <div className={s.actions}>
                <Button type="submit" size="sm" variant="primary" disabled={!risk}>
                  Сохранить риск
                </Button>
              </div>
            </form>
          </Panel>
        </div>
        <div className={s.two}>
          <Panel title="Пароль и способы входа">
            <form className={s.form} onSubmit={savePassword}>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                {identities.length === 0 ? <li className="text-2">только email-ссылка</li> : identities.map((i) => (
                  <li key={i.provider + i.label}>
                    {i.provider === "password" ? "пароль" : i.provider}: {i.label}
                  </li>
                ))}
              </ul>
              <div className={s.row}>
                <Input label="Текущий пароль" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((x) => ({ ...x, current: e.target.value }))} hint="если пароля ещё не было — оставьте пустым" />
                <Input label="Новый пароль" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw((x) => ({ ...x, next: e.target.value }))} minLength={10} />
              </div>
              <div className={s.actions}>
                <Button type="submit" size="sm" disabled={pw.next.length < 10}>
                  Сменить пароль
                </Button>
              </div>
            </form>
          </Panel>
          <NotificationsPanel userId={user.id} onMessage={note} />
        </div>
        <Panel title="Данные и аккаунт" footer="Удаление необратимо: email анонимизируется, сессии отзываются, записи журнала остаются в базе без привязки к вам 30 дней на случай ошибки.">
          <div className={s.form}>
            <div className={s.actions}>
              <Button size="sm" onClick={download}>
                Выгрузить мои данные (JSON)
              </Button>
              <Button size="sm" variant="ghost" onClick={() => logout().then(() => router.push("/"))}>
                Выйти
              </Button>
            </div>
            <div className={s.inline}>
              <input placeholder="введите email для подтверждения" aria-label="подтверждение email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} style={{ minWidth: 280 }} />
              <Button
                size="sm"
                variant="danger"
                disabled={confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()}
                onClick={async () => {
                  if (!confirm("Удалить аккаунт без возможности восстановления?")) return;
                  try {
                    await deleteAccount();
                    await logout();
                    router.push("/");
                  } catch (err) {
                    note(err instanceof Error ? err.message : "ошибка", "error");
                  }
                }}
              >
                Удалить аккаунт
              </Button>
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
