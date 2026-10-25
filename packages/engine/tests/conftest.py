from __future__ import annotations

import pytest

from engine.candles import Candle
from engine.testing import make_candles


@pytest.fixture
def h4_candles() -> list[Candle]:
    return make_candles(50)
