"use client";

/** Поддержка (план 3.16): обращения. */
import { api } from "./auth-client";

export type Ticket = { id: number; user_id: number | null; email: string; subject: string; message: string; context: Record<string, string | null>; status: "open" | "answered" | "closed"; reply: string | null; replied_at: string | null; created_at: string | null };

export const createTicket = (body: { email?: string; subject: string; message: string; page?: string | null; version?: string | null }, authed: boolean) =>
  api<Ticket>("/v1/support/tickets", { method: "POST", json: body, auth: authed });
export const getMyTickets = () => api<Ticket[]>("/v1/support/tickets");
export const getAdminTickets = (status?: string) => api<Ticket[]>(`/v1/admin/tickets${status ? `?status=${status}` : ""}`);
export const replyTicket = (id: number, reply: string, close: boolean) => api<Ticket>(`/v1/admin/tickets/${id}/reply`, { method: "POST", json: { reply, close } });
export const setTicketStatus = (id: number, status: string) => api<Ticket>(`/v1/admin/tickets/${id}?status=${status}`, { method: "PATCH" });
