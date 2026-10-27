"""2FA (план 3.12 v2): TOTP, резервные коды, статус."""

from __future__ import annotations

from datetime import UTC, datetime

import pyotp

from app import twofactor
from app.models import TwoFactor


def test_totp_verify_and_url() -> None:
    secret = twofactor.new_secret()
    code = pyotp.TOTP(secret).now()
    assert twofactor.verify_totp(secret, code)
    assert twofactor.verify_totp(secret, f"{code[:3]} {code[3:]}")  # пробел внутри допустим
    assert not twofactor.verify_totp(secret, "000000") or code == "000000"
    assert not twofactor.verify_totp(secret, "12345")
    url = twofactor.otpauth_url(secret, "trader@example.com")
    assert url.startswith("otpauth://totp/Platform:trader%40example.com?secret=")
    assert "issuer=Platform" in url


def test_backup_codes_single_use() -> None:
    plain, hashes = twofactor.make_backup_codes()
    assert len(plain) == 10 and len(set(plain)) == 10 and all(len(c) == 10 for c in plain)
    row = TwoFactor(user_id=1, secret=twofactor.new_secret(), backup_codes=list(hashes))
    row.enabled_at = datetime.now(tz=UTC)
    assert twofactor.is_enabled(row)
    assert twofactor.verify_code(row, plain[0].lower())  # регистр не важен
    assert len(row.backup_codes) == 9
    assert not twofactor.verify_code(row, plain[0])  # повторно не работает
    assert not twofactor.verify_code(row, "NOPE-NOPE-1")
    assert not twofactor.is_enabled(None)
    assert not twofactor.is_enabled(TwoFactor(user_id=2, secret="x", backup_codes=[]))
