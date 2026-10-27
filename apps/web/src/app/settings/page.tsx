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
import { changePassword, createApiKey, deleteAccount, disableTwoFactor, enableTwoFactor, exportData, getApiKeys, getIdentities, getTwoFactor, revokeApiKey, setupTwoFactor, type ApiKeyRow, type TwoFactorStatus } from "@/lib/user";
import { formatTimeUTC } from "@/lib/format";

const API_BASE = typeof window === "undefined" ? "" : window.location.origin;

/** API-ключи для чтения (план 3.10, Premium): список, создание с показом один раз, отзыв. */
function ApiKeysPanel({ note }: { note: (text: string, kind?: "ok" | "error") => void }) {
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [limit, setLimit] = useState(5);
  const [denied, setDenied] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const load = () =>
    getApiKeys()
      .then((r) => {
        setKeys(r.items);
        setLimit(r.limit);
        setDenied(null);
      })
      .catch((e: Error) => {
        setKeys([]);
        setDenied(e.message);
      });
  useEffect(() => {
    queueMicrotask(() => void load());
  }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await createApiKey(name.trim());
      setFresh(r.key);
      setName("");
      await load();
      note("Ключ создан — скопируйте его сейчас");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }
  async function revoke(k: ApiKeyRow) {
    if (!confirm(`Отозвать ключ «${k.name}» (${k.prefix}…)? Запросы с ним перестанут работать.`)) return;
    await revokeApiKey(k.id).catch((err: Error) => note(err.message, "error"));
    await load();
  }
  return (
    <Panel title="API-ключи для чтения (Premium)" footer="Ключ передаётся в заголовке X-API-Key и даёт только чтение (GET) тех же эндпоинтов /v1: сигналы, статистика, графики. Лимит 600 запросов в минуту на ключ. Ключ показывается один раз.">
      <div className={s.form} data-testid="api-keys">
        {denied ? (
          <span className="text-2">{denied}</span>
        ) : keys === null ? (
          <span className="caption">Загрузка…</span>
        ) : (
          <>
            {keys.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                {keys.map((k) => (
                  <li key={k.id}>
                    <strong>{k.name}</strong> · <code>{k.prefix}…</code> · создан {k.created_at ? formatTimeUTC(k.created_at) : "—"}
                    {k.last_used_at ? ` · использован ${formatTimeUTC(k.last_used_at)}` : " · ещё не использовался"}{" "}
                    <button type="button" className={`${s.small} ${s.danger}`} onClick={() => revoke(k)} aria-label={`отозвать ключ ${k.name}`}>
                      отозвать
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fresh && (
              <div role="region" aria-label="новый ключ">
                <p style={{ margin: "0 0 6px" }}>Новый ключ (больше не покажется):</p>
                <code style={{ display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{fresh}</code>
                <p className="caption" style={{ margin: "6px 0 0" }}>
                  Пример: <code>{`curl -H "X-API-Key: ${fresh.slice(0, 10)}…" ${API_BASE}/v1/signals?tab=all`}</code>
                </p>
              </div>
            )}
            {keys.length < limit && (
              <form className={s.form} onSubmit={create}>
                <div className={s.row}>
                  <Input label="Название ключа" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="например, мой скрипт" />
                </div>
                <div className={s.actions}>
                  <Button type="submit" size="sm" disabled={!name.trim()}>
                    Создать ключ
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

/** Двухфакторная защита (план 3.12, v2): настройка, включение по коду, резервные коды, отключение. */
function TwoFactorPanel({ note }: { note: (text: string, kind?: "ok" | "error") => void }) {
  const [st, setSt] = useState<TwoFactorStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState<string[] | null>(null);
  const load = () => getTwoFactor().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    queueMicrotask(() => void load());
  }, []);
  async function start() {
    try {
      setSetup(await setupTwoFactor());
      setCode("");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }
  async function enable(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await enableTwoFactor(code);
      setBackup(r.backup_codes);
      setSetup(null);
      setCode("");
      await load();
      note("2FA включена");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }
  async function disable(e: FormEvent) {
    e.preventDefault();
    try {
      await disableTwoFactor(code);
      setCode("");
      setBackup(null);
      await load();
      note("2FA отключена");
    } catch (err) {
      note(err instanceof Error ? err.message : "ошибка", "error");
    }
  }
  return (
    <Panel title="Двухфакторная защита (2FA)" footer="Код из приложения-аутентификатора (Google Authenticator, Aegis, 1Password и т. п.) спрашивается при каждом входе — по паролю, по ссылке из письма и через соцсети.">
      <div className={s.form} data-testid="two-factor">
        {st === null ? (
          <span className="caption">Загрузка…</span>
        ) : st.enabled ? (
          <form className={s.form} onSubmit={disable}>
            <p style={{ margin: 0 }}>
              Включена · резервных кодов осталось <strong>{st.backup_codes_left}</strong>
            </p>
            <div className={s.row}>
              <Input label="Код для отключения" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} hint="из приложения или резервный" />
            </div>
            <div className={s.actions}>
              <Button type="submit" size="sm" variant="danger" disabled={code.length < 6}>
                Отключить 2FA
              </Button>
            </div>
          </form>
        ) : setup ? (
          <form className={s.form} onSubmit={enable}>
            <p style={{ margin: 0 }}>
              1. Добавьте ключ в приложение: <a href={setup.otpauth_url}>открыть в приложении</a> или введите вручную — <code data-testid="two-factor-secret">{setup.secret}</code>
            </p>
            <div className={s.row}>
              <Input label="2. Код из приложения" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div className={s.actions}>
              <Button type="submit" size="sm" variant="primary" disabled={code.length < 6}>
                Включить 2FA
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setSetup(null)}>
                Отмена
              </Button>
            </div>
          </form>
        ) : (
          <div className={s.actions}>
            <span className="text-2">Выключена.</span>
            <Button type="button" size="sm" onClick={start}>
              Включить 2FA
            </Button>
          </div>
        )}
        {backup && (
          <div role="region" aria-label="резервные коды">
            <p style={{ margin: "0 0 6px" }}>
              Резервные коды — сохраните их сейчас, повторно они не показываются. Каждый работает один раз.
            </p>
            <code style={{ display: "block", whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{backup.join("\n")}</code>
          </div>
        )}
      </div>
    </Panel>
  );
}

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
          <TwoFactorPanel note={note} />
          <ApiKeysPanel note={note} />
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
