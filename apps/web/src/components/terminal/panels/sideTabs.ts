/**
 * Вкладки правой панели (план 2B.9 §8): реестр без JSX — порядок, имена и условие показа. SidePanel рисует
 * вкладку по id. «Разбор» (topdown, план 2A.11.12, ADR-0007) зарезервирован: вкладка видна, только если
 * /v1/chart/topdown ответил 200 (сервер включает его владельцу и админам, остальным — 404).
 */
export type SideTabId = "found" | "topdown" | "drawings" | "layers" | "layouts";

export interface SideTabCtx {
  /** Ресурс «Разбора» ответил 200. */
  topdown: boolean;
}

export interface SideTabSpec {
  id: SideTabId;
  /** Ключ перевода (русский исходник); со счётчиком — «Найдено ({n})»: доступное имя «Найдено (3)». */
  title: string;
  counted: boolean;
  enabled(ctx: SideTabCtx): boolean;
}

export const SIDE_TABS: readonly SideTabSpec[] = [
  { id: "found", title: "Найдено ({n})", counted: true, enabled: () => true },
  { id: "topdown", title: "Разбор", counted: false, enabled: (ctx) => ctx.topdown },
  { id: "drawings", title: "Рисунки ({n})", counted: true, enabled: () => true },
  { id: "layers", title: "Слои", counted: false, enabled: () => true },
  { id: "layouts", title: "Раскладки", counted: false, enabled: () => true },
];

/** Вкладки, видимые в этом контексте (порядок реестра). */
export const visibleTabs = (ctx: SideTabCtx): readonly SideTabSpec[] => SIDE_TABS.filter((x) => x.enabled(ctx));
