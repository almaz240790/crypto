import type { ReactNode, SVGProps } from "react";

/**
 * Иконки интерфейса (план 2B.9): 24 × 24, обводка 1.75 цветом текста (currentColor), без своих цветов.
 * Всегда декоративные (aria-hidden): имя даёт кнопка (IconButton label).
 */
function Svg({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconPlus = () => (
  <Svg>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconMinus = () => (
  <Svg>
    <path d="M5 12h14" />
  </Svg>
);
/** «Показать последние свечи»: стрелка к правому краю. */
export const IconToEnd = () => (
  <Svg>
    <path d="M4 12h12M12 7l5 5-5 5M20 5v14" />
  </Svg>
);
export const IconCamera = () => (
  <Svg>
    <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);
export const IconGrid = () => (
  <Svg>
    <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
  </Svg>
);
export const IconMagnet = () => (
  <Svg>
    <path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z" />
    <path d="M6 8h4M14 8h4" />
  </Svg>
);
export const IconUndo = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const IconRedo = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
);
export const IconLayers = () => (
  <Svg>
    <path d="M12 4l8 4-8 4-8-4z" />
    <path d="M4 12l8 4 8-4M4 16l8 4 8-4" />
  </Svg>
);
export const IconChevronDown = () => (
  <Svg width="14" height="14">
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconLock = () => (
  <Svg width="10" height="10" strokeWidth="2.5">
    <path d="M6 11h12v9H6z" />
    <path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
  </Svg>
);
export const IconClose = () => (
  <Svg>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconMore = () => (
  <Svg>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="3" />
  </Svg>
);
export const IconPanel = () => (
  <Svg>
    <path d="M4 5h16v14H4zM14 5v14" />
  </Svg>
);
export const IconView = () => (
  <Svg>
    <path d="M7 4v16M17 4v16" />
    <path d="M5 8h4v8H5zM15 6h4v9h-4z" />
  </Svg>
);
export const IconInfo = () => (
  <Svg>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
/** Меню разделов (рейка AppShell). */
export const IconMenu = () => (
  <Svg>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
/** Колокол алерта (монохромный, план 2A.6). */
export const IconBell = () => (
  <Svg>
    <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
);
/** Индикаторы: линия поверх свечей. */
export const IconIndicators = () => (
  <Svg>
    <path d="M3 17l5-6 4 4 4-7 5 5" />
    <path d="M3 21h18" />
  </Svg>
);
/** Полный экран. */
export const IconExpand = () => (
  <Svg>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Svg>
);
/** «Горячие клавиши»: клавиатура. */
export const IconKeyboard = () => (
  <Svg>
    <path d="M3 7h18v10H3z" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M17 13.5H7" />
  </Svg>
);
/** «Раскладки» (сохранённые наборы): закладка — не путать с «Мультичартом» (сетка). */
export const IconBookmark = () => (
  <Svg>
    <path d="M7 4h10v16l-5-4-5 4z" />
  </Svg>
);
/** «Разбор сверху вниз» (резерв): три ступени — неделя, день, 4ч. */
export const IconSteps = () => (
  <Svg>
    <path d="M4 6h6M7 12h7M10 18h10" />
  </Svg>
);
/** «Панель выше» (ADR-0009, «Управление панелями»). */
export const IconArrowUp = () => (
  <Svg>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);
/** «Панель ниже». */
export const IconArrowDown = () => (
  <Svg>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
/** «Развернуть панель на весь график»: рамка со стрелками наружу. */
export const IconMaximize = () => (
  <Svg>
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </Svg>
);
/** «Вернуть панели»: стрелки внутрь. */
export const IconRestore = () => (
  <Svg>
    <path d="M20 4l-7 7M4 20l7-7M13 5v6h6M11 19v-6H5" />
  </Svg>
);
/** «Настройки» (параметры индикатора): шестерёнка. */
export const IconGear = () => (
  <Svg>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Svg>
);
/** Вертикальный масштаб шкалы цены: стрелки вверх и вниз. */
export const IconScaleVertical = () => (
  <Svg>
    <path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4" />
  </Svg>
);
