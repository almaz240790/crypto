"""2FA по TOTP (RFC 6238; план 3.12, v2). Чистые функции: секрет, URL для приложения,
проверка кода с окном ±1 шаг, резервные коды (10 штук, хранятся sha256-хэшами)."""

from __future__ import annotations

import secrets

import pyotp

from app import auth
from app.models import TwoFactor

ISSUER = "Platform"
BACKUP_CODES = 10
BACKUP_LEN = 10  # символов base32 без похожих букв
VALID_WINDOW = 1  # ±30 с на расхождение часов
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_secret() -> str:
    return pyotp.random_base32()


def otpauth_url(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def verify_totp(secret: str, code: str) -> bool:
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        return False
    return bool(pyotp.TOTP(secret).verify(digits, valid_window=VALID_WINDOW))


def _normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def make_backup_codes() -> tuple[list[str], list[str]]:
    """(коды для показа один раз, хэши для хранения)."""
    plain = [
        "".join(secrets.choice(_ALPHABET) for _ in range(BACKUP_LEN)) for _ in range(BACKUP_CODES)
    ]
    return plain, [auth.sha256(c) for c in plain]


def verify_code(row: TwoFactor, code: str) -> bool:
    """TOTP или резервный код; использованный резервный код удаляется (нужен commit снаружи)."""
    if verify_totp(row.secret, code):
        return True
    h = auth.sha256(_normalize_backup(code))
    if h in row.backup_codes:
        row.backup_codes = [x for x in row.backup_codes if x != h]
        return True
    return False


def is_enabled(row: TwoFactor | None) -> bool:
    return row is not None and row.enabled_at is not None
