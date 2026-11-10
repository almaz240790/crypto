"""Одноразовая ссылка входа в админку без почты (ADR-0011, «Восстановление»).

Запуск на сервере (one-off, нужен доступ к хостингу — это и есть подтверждение личности):
  python scripts/admin_link.py owner@example.com

Печатает ссылку вида {FRONTEND_URL}/admin/login?link=… — та же ссылка, что пришла бы письмом:
действует 30 минут, срабатывает один раз. По ней открывается код из приложения, а если 2FA ещё
не настроена (первый вход, сброс через admin_2fa_reset.py) — первая настройка с QR-кодом.
Нужна, когда письмо не доходит или на сервере не настроена отправка писем (нет RESEND_API_KEY):
первую настройку кода одним паролем открыть нельзя. До настройки админка открыта и так — по входу на
сайт (переходный режим ADR-0011), поэтому скрипт — запасной путь, а не единственный.
Только для аккаунтов с ролью admin/owner или из OWNER_EMAILS; адрес из OWNER_EMAILS при этом
считается подтверждённым (ссылку выдал тот, у кого есть сервер).
"""

from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "api"))

from sqlalchemy import select

from app import admin_auth
from app.config import settings
from app.db import SessionLocal
from app.models import AdminAudit, User

TTL = timedelta(minutes=30)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("email")
    email = ap.parse_args().email.strip().lower()
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == email))
        if user is None:
            print("пользователь не найден: сначала зарегистрируйтесь на сайте", file=sys.stderr)
            return 1
        if not admin_auth.can_receive_link(user):
            print("это не админ (или аккаунт заблокирован) — отказ", file=sys.stderr)
            return 2
        raw = admin_auth.issue_email_token(db, user, admin_auth.MAGIC_PURPOSE, TTL)
        db.add(
            AdminAudit(
                actor_id=user.id,
                action="admin_login.link_by_script",
                target=admin_auth.AUDIT_TARGET,
                payload={"minutes": int(TTL.total_seconds() // 60)},
            )
        )
        db.commit()
    print(f"ССЫЛКА (30 минут, один раз): {settings.frontend_url}/admin/login?link={raw}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
