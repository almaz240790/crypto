"use client";

import { api } from "./auth-client";

function b64ToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Подписаться: разрешение → ключ сервера → подписка в браузере → сохранить на API. */
export async function subscribePush(): Promise<string> {
  if (!pushSupported()) return "браузер не поддерживает push";
  const { key } = await api<{ key: string | null }>("/v1/push/public-key", { auth: false });
  if (!key) return "push на сервере не настроен";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "разрешение не выдано";
  const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) as BufferSource });
  const j = sub.toJSON();
  await api("/v1/me/push", { method: "POST", json: { endpoint: sub.endpoint, keys: j.keys } });
  return "подписка включена";
}

export async function unsubscribePush(): Promise<string> {
  const sub = await currentSubscription();
  if (!sub) return "подписки нет";
  await api("/v1/me/push", { method: "DELETE", json: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
  return "подписка выключена";
}

export function testPush(): Promise<{ sent: number; status: string }> {
  return api<{ sent: number; status: string }>("/v1/me/push/test", { method: "POST" });
}
