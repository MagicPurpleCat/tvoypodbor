import { tg, inTelegram } from './tg';

// В проде без VITE_API_URL — тот же сайт, что и Mini App (бот и приложение в одном контейнере)
const API = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');
// Вне Telegram в dev-режиме — моки, чтобы верстать экраны в обычном браузере
const USE_MOCK = !inTelegram && import.meta.env.DEV;

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data: Record<string, unknown> = {}) {
    super(code);
  }
}

/** Глобальный обработчик лимита: App подписывается и открывает экран подписки. */
export const limitEvents = new EventTarget();

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (USE_MOCK) return (await import('./mock')).mockFetch(method, path, body) as Promise<T>;
  let res: Response;
  try {
    res = await fetch(API + '/api' + path, {
      method,
      headers: {
        Authorization: `tma ${tg?.initData ?? ''}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'OFFLINE');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error ?? {};
    const e = new ApiError(res.status, err.code ?? 'INTERNAL', err);
    if (e.code === 'LIMIT_EXCEEDED') limitEvents.dispatchEvent(new CustomEvent('limit', { detail: err }));
    throw e;
  }
  return data as T;
}

// ---- типы ответов ----
export interface Salary { from: number | null; to: number | null; currency: string | null; gross?: boolean | null }
export interface VacancyCard {
  id: number; title: string; company: string | null; city: string | null; salary: Salary | null;
  schedule: string | null; experience: string | null; snippet: string; publishedAt: string | null;
}
export interface Vacancy extends Omit<VacancyCard, 'snippet'> {
  employment: string | null; keySkills: string[]; description: string; url: string; archived: boolean;
}
export interface Quota { unlimited: boolean; limit: number; used: number; remaining: number | null; resetAt: string }
export interface ActiveSub { plan: 'week' | 'month' | 'quarter'; expiresAt: string }
export interface Plan { id: 'week' | 'month' | 'quarter'; title: string; days: number; price: number; perDay: number }
export interface SearchParams {
  text: string; area?: string; salary?: number; onlyWithSalary?: boolean;
  experience?: string; schedule?: string; page?: number;
}
export interface Resume {
  full_name: string; desired_position: string; city: string | null;
  contacts: { phone?: string; email?: string; telegram?: string };
  experience: { company: string; position: string; from: string; to: string | null; achievements?: string }[];
  skills: string[];
  education: { institution: string; degree?: string; year?: number }[];
  portfolio: { title: string; url: string }[];
  about: string;
}
export interface Me {
  user: { first_name: string | null; username: string | null; created_at: string };
  quota: Quota;
  subscription: ActiveSub | null;
  stats: { accepted: number; rejected: number; favorites: number; applied: number; viewed: number; letters: number; funnel: Record<string, number> };
}
export interface HistoryItem {
  id: number; action: string; status: string | null; meta: Record<string, unknown>; created_at: string;
  vacancy_id: number | null; title: string | null; company: string | null;
}

const qs = (o: object) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export const api = {
  me: () => request<Me>('GET', '/me'),
  search: (p: SearchParams) => request<{ items: VacancyCard[]; found: number; pages: number; page: number }>('GET', `/vacancies/search?${qs(p)}`),
  areas: (q: string) => request<{ items: { id: string; text: string }[] }>('GET', `/areas?${qs({ q })}`),
  vacancy: (id: number) => request<{ vacancy: Vacancy; isFavorite: boolean; lastAction: { action: string; status: string | null } | null }>('GET', `/vacancies/${id}`),
  decide: (id: number, decision: 'accept' | 'reject') => request<void>('POST', `/vacancies/${id}/decision`, { decision }),
  setStatus: (id: number, status: string) => request<void>('POST', `/vacancies/${id}/status`, { status }),
  favorites: () => request<{ items: (Omit<VacancyCard, 'salary' | 'snippet'> & { salary_from: number | null; salary_to: number | null; salary_currency: string | null; archived: boolean; added_at: string })[] }>('GET', '/favorites'),
  addFavorite: (id: number) => request<void>('PUT', `/favorites/${id}`, {}),
  removeFavorite: (id: number) => request<void>('DELETE', `/favorites/${id}`),
  coverLetter: (vacancyId: number, tone: 'formal' | 'friendly' | 'short') => request<{ text: string; provider: string; vacancyUrl: string }>('POST', '/cover-letter', { vacancyId, tone }),
  resume: () => request<{ resume: Resume | null }>('GET', '/resume'),
  saveResume: (r: Resume) => request<{ resume: Resume }>('PUT', '/resume', r),
  history: (cursor?: number) => request<{ items: HistoryItem[]; nextCursor: number | null }>('GET', `/history?${qs({ cursor })}`),
  subscription: () => request<{ active: ActiveSub | null; quota: Quota; plans: Plan[]; methods: string[] }>('GET', '/subscription'),
  checkout: (plan: string, method: string) => request<{ subscriptionId: number; paymentUrl: string; expiresIn: string | null }>('POST', '/subscription/checkout', { plan, method }),
  paymentStatus: (id: number) => request<{ id: number; status: string; expires_at: string | null }>('GET', `/subscription/payments/${id}`),
  faq: () => request<{ items: { q: string; a: string }[] }>('GET', '/support/faq'),
  sendTicket: (topic: string, message: string) => request<{ id: number }>('POST', '/support/tickets', { topic, message }),
};
