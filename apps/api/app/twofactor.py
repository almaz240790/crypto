"""2FA по TOTP (RFC 6238; план 3.12, v2): секрет, URL для приложения, проверка кода с окном ±1 шаг,
резервные коды (10 штук, хранятся sha256-хэшами).

Код из приложения принимается один раз — и на сайте, и в админке (RFC 6238, 5.2): номер принятого
30-секундного шага хранится в ``two_factor_secrets.last_step``, следующий код должен быть новее.
Строку 2FA для проверки кода берут через :func:`locked` (SELECT … FOR UPDATE до commit), чтобы два
одновременных запроса с одним кодом или одним резервным кодом не прошли оба (ADR-0011)."""

from __future__ import annotations

import hmac
import secrets
from datetime import UTC, datetime

import pyotp
from sqlalchemy.orm import Session

from app import auth
from app.models import TwoFactor

ISSUER = "PlatformSol"  # подпись в приложении-аутентификаторе («Пароли» на iPhone и др.)
BACKUP_CODES = 10
BACKUP_LEN = 10  # символов base32 без похожих букв
VALID_WINDOW = 1  # ±30 с на расхождение часов
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_secret() -> str:
    return pyotp.random_base32()


def otpauth_url(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def matched_step(secret: str, code: str, now: datetime | None = None) -> int | None:
    """Номер 30-секундного шага, которому соответствует код (окно ±1 шаг), или None."""
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        return None
    totp = pyotp.TOTP(secret)
    base = int(totp.timecode(now or datetime.now(tz=UTC)))
    for step in (
        base,
        *range(base - VALID_WINDOW, base),
        *range(base + 1, base + VALID_WINDOW + 1),
    ):
        if hmac.compare_digest(str(totp.generate_otp(step)), digits):
            return int(step)
    return None


def verify_totp(secret: str, code: str) -> bool:
    """Код подходит к секрету (без отметки об использовании — для проверок без входа)."""
    return matched_step(secret, code) is not None


def _normalize_backup(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def make_backup_codes() -> tuple[list[str], list[str]]:
    """(коды для показа один раз, хэши для хранения)."""
    plain = [
        "".join(secrets.choice(_ALPHABET) for _ in range(BACKUP_LEN)) for _ in range(BACKUP_CODES)
    ]
    return plain, [auth.sha256(c) for c in plain]


def locked(db: Session, user_id: int) -> TwoFactor | None:
    """Строка 2FA под блокировкой до commit/rollback: проверка кода и отметка идут без гонки."""
    return db.get(TwoFactor, user_id, with_for_update=True, populate_existing=True)


def reset_secret(row: TwoFactor, secret: str) -> None:
    """Новый (ещё не включённый) секрет: старые резервные коды и отметка шага не переносятся."""
    row.secret = secret
    row.backup_codes = []
    row.last_step = None


def use_totp(row: TwoFactor, code: str, now: datetime | None = None) -> bool:
    """Код из приложения, один раз: шаг новее последнего принятого (commit снаружи)."""
    step = matched_step(row.secret, code, now)
    if step is None or (row.last_step is not None and step <= row.last_step):
        return False
    row.last_step = step
    return True


def use_code(row: TwoFactor, code: str, now: datetime | None = None) -> str | None:
    """«totp», «backup» (резервный код сгорает) или None. Строку брать через :func:`locked`."""
    if use_totp(row, code, now):
        return "totp"
    h = auth.sha256(_normalize_backup(code))
    if h in row.backup_codes:
        row.backup_codes = [x for x in row.backup_codes if x != h]
        return "backup"
    return None


def verify_code(row: TwoFactor, code: str) -> bool:
    """TOTP (один раз) или резервный код (сгорает); нужен commit снаружи."""
    return use_code(row, code) is not None


def is_enabled(row: TwoFactor | None) -> bool:
    return row is not None and row.enabled_at is not None
