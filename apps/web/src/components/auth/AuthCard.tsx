import type { ReactNode } from "react";
import { Footer, Header } from "@/components/site";
import { Panel } from "@/components/ui";
import s from "./AuthCard.module.css";

export function AuthCard({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <Header />
      <main className={`container ${s.main}`}>
        <div className={s.card}>
          <Panel title={title} footer={footer}>
            {children}
          </Panel>
        </div>
      </main>
      <Footer />
    </>
  );
}

export { s as authStyles };
