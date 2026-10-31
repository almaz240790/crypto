import type { Metadata } from "next";
import { OfflineBody } from "./OfflineBody";

export const metadata: Metadata = { title: "Offline", robots: { index: false } };

export default function OfflinePage() {
  return (
    <main className="container" style={{ paddingBlock: 24, maxWidth: 480 }}>
      <OfflineBody />
    </main>
  );
}
