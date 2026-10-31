import type { ReactNode } from "react";
import { Footer, Header } from "@/components/site";
import s from "./AuthCard.module.css";

export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        <section className={s.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={s.title}>
            {title}
          </h1>
          {children}
          {footer && <div className={s.foot}>{footer}</div>}
        </section>
      </main>
      <Footer />
    </>
  );
}

export { s as authStyles };
