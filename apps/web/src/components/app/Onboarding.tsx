"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button, Input, Panel, Select } from "@/components/ui";
import { patchRisk, type Me } from "@/lib/auth-client";
import s from "./Onboarding.module.css";

const TG_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;
const STEPS = ["Опыт", "Риск", "Уведомления"];

type Exp = "novice" | "experienced" | "systematic";
const EXP: { v: Exp; t: string; d: string }[] = [
  { v: "novice", t: "Начинаю", d: "Подсказки в карточке сигнала, пояснение каждого термина, уведомления только по сигналам градации A." },
  { v: "experienced", t: "Торгую давно", d: "Краткие подсказки, все градации, уведомления по сигналам и срабатыванию стопа/целей." },
  { v: "systematic", t: "Торгую системно", d: "Без подсказок, полный доступ к статистике и выгрузке, уведомления по всем событиям." },
];

export function Onboarding({ user }: { user: Me }) {
  const router = useRouter();
  const { reload } = useAuth();
  const [step, setStep] = useState(0);
  const [exp, setExp] = useState<Exp | "">((user.risk.experience as Exp | null) ?? "");
  const [deposit, setDeposit] = useState(user.risk.deposit ?? "");
  const [risk, setRisk] = useState(user.risk.risk_pct ? String(Number(user.risk.risk_pct)) : "1.0");
  const [exchange, setExchange] = useState(user.risk.exchange || "binance");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await patchRisk(body);
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "не удалось сохранить");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const finish = () => router.replace("/signals");

  return (
    <div className={s.wrap}>
      <div className={s.steps} aria-label="шаги">
        {STEPS.map((t, i) => (
          <span key={t} className={i === step ? s.cur : i < step ? s.done : ""}>
            {i + 1}. {t}
          </span>
        ))}
      </div>

      {step === 0 && (
        <Panel title="Как вы торгуете?" footer="Влияет только на подсказки и настройки уведомлений по умолчанию. Можно изменить в настройках.">
          <div className={s.form}>
            <div className={s.options} role="radiogroup">
              {EXP.map((o) => (
                <label key={o.v} className={s.opt}>
                  <input type="radio" name="experience" value={o.v} checked={exp === o.v} onChange={() => setExp(o.v)} />
                  <div>
                    <strong>{o.t}</strong>
                    <span>{o.d}</span>
                  </div>
                </label>
              ))}
            </div>
            {error && <div className={s.error}>{error}</div>}
            <div className={s.actions}>
              <Button variant="ghost" onClick={() => setStep(1)}>
                Пропустить
              </Button>
              <Button
                variant="primary"
                disabled={!exp || busy}
                onClick={async () => {
                  if (await save({ experience: exp })) setStep(1);
                }}
              >
                Дальше
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {step === 1 && (
        <Panel title="Параметры риска" footer="Депозит нужен только калькулятору размера позиции и хранится по вашему желанию. Можно оставить пустым.">
          <div className={s.form}>
            <div className={s.row}>
              <Input label="Депозит, USDT (необязательно)" mono inputMode="decimal" name="deposit" value={deposit} onChange={(e) => setDeposit(e.target.value)} placeholder="—" />
              <Input label="Риск на сделку, %" mono inputMode="decimal" name="risk_pct" value={risk} onChange={(e) => setRisk(e.target.value)} hint="по умолчанию 1 %, допустимо до 10" />
            </div>
            <Select label="Биржа" name="exchange" value={exchange} onChange={(e) => setExchange(e.target.value)} hint="влияет на тикеры и ссылки в карточке сигнала">
              <option value="binance">Binance</option>
              <option value="bybit">Bybit</option>
            </Select>
            {error && <div className={s.error}>{error}</div>}
            <div className={s.actions}>
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="ghost" onClick={() => setStep(0)}>
                  Назад
                </Button>
                <Button variant="ghost" onClick={() => setStep(2)}>
                  Пропустить
                </Button>
              </div>
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  const r = Number(risk.replace(",", "."));
                  if (!(r > 0 && r <= 10)) {
                    setError("риск на сделку — число от 0.1 до 10");
                    return;
                  }
                  const body: Record<string, unknown> = { risk_pct: r, exchange };
                  const d = deposit.trim().replace(",", ".");
                  if (d) {
                    if (!(Number(d) >= 0)) {
                      setError("депозит — число или пусто");
                      return;
                    }
                    body.deposit = d;
                  }
                  if (await save(body)) setStep(2);
                }}
              >
                Дальше
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {step === 2 && (
        <Panel title="Уведомления" footer="Логика сигналов не зависит от канала: все каналы получают одно и то же в одно время.">
          <div className={s.form}>
            <div className={s.options}>
              <div className={s.opt} style={{ cursor: "default" }}>
                <span aria-hidden="true" />
                <div>
                  <strong>Telegram</strong>
                  <span>
                    {TG_BOT ? (
                      <>
                        Откройте бота и нажмите «Start»: {" "}
                        <a href={`https://t.me/${TG_BOT}?start=${user.id}`} target="_blank" rel="noreferrer">
                          t.me/{TG_BOT}
                        </a>
                      </>
                    ) : (
                      "Бот подключается после запуска уведомлений (задача 2.13). Привязка появится здесь."
                    )}
                  </span>
                </div>
              </div>
              <div className={s.opt} style={{ cursor: "default" }}>
                <span aria-hidden="true" />
                <div>
                  <strong>Email-дайджест</strong>
                  <span>Раз в день, по закрытым сигналам. Включён для подтверждённого адреса{` ${user.email}`}.</span>
                </div>
              </div>
              <div className={s.opt} style={{ cursor: "default" }}>
                <span aria-hidden="true" />
                <div>
                  <strong>Push в браузере</strong>
                  <span>Появится вместе с установкой приложения на телефон (PWA, задача 2.15).</span>
                </div>
              </div>
            </div>
            <div className={s.actions}>
              <Button variant="ghost" onClick={() => setStep(1)}>
                Назад
              </Button>
              <Button variant="primary" onClick={finish}>
                Перейти к сигналам
              </Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}
