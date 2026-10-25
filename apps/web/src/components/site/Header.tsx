import Link from "next/link";
import { Button, ThemeToggle } from "@/components/ui";
import s from "./Header.module.css";

export function Header() {
  return (
    <header className={s.header}>
      <div className={`container ${s.inner}`}>
        <Link href="/" className={s.brand}>
          Platform
        </Link>
        <nav className={s.nav} aria-label="разделы">
          <Link href="/#signals">Сигналы</Link>
          <Link href="/#stats">Статистика</Link>
          <Link href="/#rules">Правила</Link>
          <Link href="/#pricing">Тарифы</Link>
          <Link href="/#faq">Вопросы</Link>
        </nav>
        <div className={s.right}>
          <ThemeToggle />
          <Button href="/login" variant="primary" size="sm">
            Войти
          </Button>
        </div>
      </div>
    </header>
  );
}
