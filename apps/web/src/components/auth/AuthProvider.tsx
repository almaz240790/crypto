"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getMe, hasHint, logout as doLogout, type Me } from "@/lib/auth-client";

type AuthState = {
  user: Me | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
};

const Ctx = createContext<AuthState>({
  user: null,
  loading: true,
  reload: async () => {},
  logout: async () => {},
});

const noop = () => () => {};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [pending, setPending] = useState(true);
  // На сервере подсказка неизвестна (true), в браузере — по cookie; без неё API не дёргаем.
  const hint = useSyncExternalStore(noop, hasHint, () => true);
  const loading = pending && hint;

  const reload = useCallback(async () => {
    try {
      setUser(await getMe());
    } catch {
      setUser(null);
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    // Загрузка профиля — внешняя система (API); в микрозадаче, чтобы не каскадить рендер.
    if (hasHint()) queueMicrotask(() => void reload());
  }, [reload]);

  const logout = useCallback(async () => {
    await doLogout();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, reload, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  return useContext(Ctx);
}
