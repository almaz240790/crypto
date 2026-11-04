"use client";

import { createContext } from "react";
import type { LegendFit } from "./legendFit";

/** Место легенды в основной панели (ChartSurface → OhlcLegend): строк без раскрытия и прокрутка раскрытой. */
export const LegendFitContext = createContext<LegendFit | null>(null);
