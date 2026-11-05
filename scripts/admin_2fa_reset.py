"""Сброс 2FA админа, который потерял телефон и резервные коды (ADR-0011, «Восстановление»).

Запуск на сервере (one-off, нужен доступ к хостингу — это и есть подтверждение личности):
  python scripts/admin_2fa_reset.py owner@example.com

Что делает: отключает двухфакторную защиту аккаунта (удаляет секрет и резервные коды), закрывает
все сеансы админки и пишет строку в аудит. При следующем входе на /admin/login после пароля
(или ссылки из письма) откроется первая настройка: новый QR-код и новые резервные коды.
Пароль и сессии сайта не меняет. Только для аккаунтов с ролью admin/owner или из OWNER_EMAILS.
Скрипт ничего не печатает о секрете — печатать нечего: секрет удаляется.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from sqlalchemy import select

from app import admin_auth
from app.db import SessionLocal
from app.models import AdminAudit, TwoFactor, User


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("email")
    ap.add_argument("--reason", default="потерян телефон и резервные коды")
    args = ap.parse_args()
    email = args.email.strip().lower()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            print("пользователь не найден", file=sys.stderr)
            return 1
        if not admin_auth.is_admin_account(user):
            print("это не админ — сброс 2FA пользователей делается не так", file=sys.stderr)
            return 2
        row = db.get(TwoFactor, user.id)
        if row is not None:
            db.delete(row)
        closed = admin_auth.revoke_user_sessions(db, user.id)
        db.add(
            AdminAudit(
                actor_id=user.id,
                action="admin_2fa.reset_by_script",
                target=f"user:{user.id}",
                payload={"reason": args.reason[:200], "sessions_closed": closed},
            )
        )
        db.commit()
    print(
        f"2FA сброшена, закрыто сеансов админки: {closed}. "
        "Следующий вход на /admin/login начнётся с настройки нового кода."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
