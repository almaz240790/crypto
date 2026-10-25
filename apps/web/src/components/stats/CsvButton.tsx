"use client";

import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { Button } from "@/components/ui";
import { getAccessToken } from "@/lib/auth-client";

/** Экспорт CSV — только с логином (правило честности 4). Токен в заголовке, поэтому через fetch. */
export function CsvButton({ query }: { query: string }) {
  const { user, loading } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (loading) return null;
  if (!user) {
    return (
      <span className="caption">
        CSV — <Link href={`/login?next=${encodeURIComponent(`/stats?${query}`)}`}>после входа</Link>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const res = await fetch(`/v1/stats/export.csv?${query}`, {
              headers: { authorization: `Bearer ${getAccessToken() ?? ""}` },
              credentials: "include",
            });
            if (!res.ok) throw new Error(res.status === 403 ? "недоступно для этой области" : `ошибка ${res.status}`);
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = (res.headers.get("content-disposition") ?? "").split("filename=")[1] ?? "signals.csv";
            a.click();
            URL.revokeObjectURL(url);
          } catch (e) {
            setErr(e instanceof Error ? e.message : "ошибка");
          } finally {
            setBusy(false);
          }
        }}
      >
        Скачать CSV
      </Button>
      {err && <span className="caption down">{err}</span>}
    </span>
  );
}

