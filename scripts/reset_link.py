"""Одноразовая ссылка для смены пароля владельца без почты (пока не настроен Resend).

Запуск на сервере (one-off):
  python scripts/reset_link.py diamond240790a@gmail.com

Печатает ссылку вида {FRONTEND_URL}/reset?token=… — действует 1 час, сгорает после использования.
Разрешено только для адресов из OWNER_EMAILS: это не обход восстановления для обычных пользователей.
Пароль скрипт не задаёт и не знает: его вводит владелец на странице по ссылке.
"""

from __future__ import annotations

import argparse
import secrets
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from sqlalchemy import select  # noqa: E402

from app import auth  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import EmailToken, User  # noqa: E402

TTL = timedelta(hours=1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("email")
    email = ap.parse_args().email.strip().lower()
    if email not in settings.owner_email_set:
        print("адрес не в OWNER_EMAILS — отказ", file=sys.stderr)
        return 2
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            print("пользователь не найден: зарегистрируйтесь на сайте", file=sys.stderr)
            return 1
        raw = secrets.token_urlsafe(32)
        db.add(
            EmailToken(
                user_id=user.id,
                purpose="reset",
                token_hash=auth.sha256(raw),
                expires_at=datetime.now(tz=UTC) + TTL,
            )
        )
        db.commit()
    print(f"ССЫЛКА (1 час): {settings.frontend_url}/reset?token={raw}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
