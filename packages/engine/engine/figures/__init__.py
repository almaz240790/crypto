"""Графические фигуры: алгоритмический поиск кандидатов (план 2A.10.2, шаг 1; задача 4B.1).

Фигуры не являются сигналами (2A.10.5). ML-ранжирование — отдельный шаг (4B.2–4B.5).
"""

from engine.figures.detect import confirmed_only, detect_figures, with_status
from engine.figures.outcomes import FigureOutcome, figure_outcome
from engine.figures.params import DEFAULT_FIGURE_PARAMS, FigureParams
from engine.figures.types import TITLES, Figure, FigureStatus, FigureType, Line, Point

__all__ = [
    "DEFAULT_FIGURE_PARAMS",
    "TITLES",
    "Figure",
    "FigureOutcome",
    "FigureParams",
    "FigureStatus",
    "FigureType",
    "Line",
    "Point",
    "confirmed_only",
    "detect_figures",
    "figure_outcome",
    "with_status",
]
