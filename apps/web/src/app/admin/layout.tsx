import type { Metadata } from "next";
import type { ReactNode } from "react";

/** Админка (ADR-0011): не индексируется и не попадает в поиск; вход — только по адресу /admin/login. */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
