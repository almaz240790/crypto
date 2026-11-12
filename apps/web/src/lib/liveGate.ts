import type { Tone } from "@/components/ui/Badge";

/** Критерий отчёта «готовность к live» (сводка `summary_json`, задача 9 пакета «Сигналы»). */
export type GateCriterion = { name: string; source: string; value: string; status: string };

export type GateSummary = {
  version: string;
  symbols_label: string;
  symbols: string[];
  backtest_from: string;
  backtest_to: string;
  now: string;
  forward: {
    version: string;
    in_db: boolean;
    status: string | null;
    since: string | null;
    end: string | null;
    days: string | null;
    signals: number;
    counted: number;
    closed_h4: number;
    avg_r_h4: string | null;
    closed_1m: number;
    avg_r_1m: string | null;
  };
  backtest: {
    closed: number;
    winrate: string | null;
    avg_r: string | null;
    profit_factor: string | null;
    sum_r: string | null;
    max_drawdown_r: string | null;
  };
  criteria: GateCriterion[];
  counts: { met: number; not_met: number; human: number };
};

/** Отчёт по одной цели: сводка и Markdown или ошибка построения. */
export type GateReport = {
  title: string;
  version: string;
  symbols_of: string | null;
  markdown?: string;
  summary?: GateSummary;
  error?: string;
};

export type LiveGate = { at: string | null; reports: GateReport[]; failed: string | null; schedule: string };

/** Цвет статуса критерия: тексты статусов — как в отчёте (`Status` в `live_gate_report.py`). */
export function gateTone(status: string): Tone {
  if (status === "выполнено") return "up";
  if (status === "не выполнено") return "down";
  return "warn";
}

/** Имя файла отчёта для скачивания: `live-gate-<номер версии>[-для-<кандидат>]-<дата отчёта>.md`. */
export function gateFileName(report: GateReport, at: string | null): string {
  const num = (v: string) => v.slice(v.lastIndexOf("@") + 1);
  const day = (report.summary?.now ?? at ?? "").slice(0, 10) || "отчёт";
  const target = report.symbols_of ? `-для-${num(report.symbols_of)}` : "";
  return `live-gate-${num(report.version)}${target}-${day}.md`;
}
