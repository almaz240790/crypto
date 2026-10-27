"""Сессии и устройства (план 3.12 v2): подпись устройства по User-Agent."""

from __future__ import annotations

from app.sessions import device_label


def test_device_label() -> None:
    mac = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    )
    assert device_label(mac) == "Chrome · macOS"
    iphone = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
        "Version/17.0 Mobile/15E148 Safari/604.1"
    )
    assert device_label(iphone) == "Safari · iPhone"
    assert (
        device_label("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/131.0")
        == "Firefox · Windows"
    )
    assert (
        device_label("Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Edg/130.0 Safari/537.36")
        == "Edge · Linux"
    )
    assert device_label("python-httpx/0.27") == "скрипт"
    assert device_label(None) == "устройство" and device_label("") == "устройство"
