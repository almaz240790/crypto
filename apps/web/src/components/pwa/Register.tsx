"use client";

import { useEffect } from "react";

/** Регистрация service worker. Только в проде и только если браузер умеет. */
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_SW_DEV) return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
