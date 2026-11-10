import type { Metadata } from "next";
import { NotFound } from "@/components/site/NotFound";

export const metadata: Metadata = { title: "404", robots: { index: false, follow: false } };

export default function NotFoundPage() {
  return <NotFound />;
}
