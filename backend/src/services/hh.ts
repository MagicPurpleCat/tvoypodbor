// Источник вакансий — публичный API hh.ru (https://api.hh.ru/openapi/redoc).
// Результаты поиска кэшируются в KV (Redis или память), сами вакансии — в таблице vacancies.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db.js';
import { kv } from '../redis.js';
import { AppError } from '../errors.js';

const HH = 'https://api.hh.ru';

export const searchSchema = z.object({
  text: z.string().trim().max(200).default(''),
  area: z.string().regex(/^\d+$/).optional(), // id региона hh: 1 — Москва, 2 — СПб, 113 — Россия
  salary: z.coerce.number().int().positive().max(10_000_000).optional(),
  onlyWithSalary: z.coerce.boolean().default(false),
  experience: z.enum(['noExperience', 'between1And3', 'between3And6', 'moreThan6']).optional(),
  schedule: z.enum(['fullDay', 'remote', 'flexible', 'shift', 'flyInFlyOut']).optional(),
  employment: z.enum(['full', 'part', 'project', 'probation']).optional(),
  orderBy: z.enum(['relevance', 'publication_time', 'salary_desc']).default('relevance'),
  page: z.coerce.number().int().min(0).max(99).default(0),
});
export type SearchParams = z.infer<typeof searchSchema>;

interface HhItem {
  id: string;
  name: string;
  area?: { name: string };
  salary?: { from: number | null; to: number | null; currency: string; gross?: boolean } | null;
  employer?: { name: string };
  snippet?: { requirement?: string | null; responsibility?: string | null };
  schedule?: { id: string };
  experience?: { id: string };
  employment?: { id: string };
  published_at?: string;
  alternate_url: string;
  archived?: boolean;
  description?: string;
  key_skills?: { name: string }[];
}

async function hhGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(HH + path);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { 'HH-User-Agent': config.HH_USER_AGENT, 'User-Agent': config.HH_USER_AGENT };
  if (config.HH_APP_TOKEN) headers.Authorization = `Bearer ${config.HH_APP_TOKEN}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) throw new AppError(404, 'NOT_FOUND');
  if (!res.ok) {
    console.error(`hh ${path} -> ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    throw new AppError(503, 'UPSTREAM_UNAVAILABLE', 'hh.ru unavailable');
  }
  return (await res.json()) as T;
}

export const stripHtml = (html?: string | null) =>
  (html ?? '')
    .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Upsert вакансии hh в нашу таблицу, вернуть наш id. */
async function upsert(v: HhItem): Promise<number> {
  const full = v.description !== undefined;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO vacancies (source, external_id, title, company, city, salary_from, salary_to, salary_currency,
       salary_gross, experience, schedule, employment, key_skills, description, url, published_at, archived, raw, fetched_at)
     VALUES ('hh', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT (source, external_id) DO UPDATE SET
       title = EXCLUDED.title, company = EXCLUDED.company, city = EXCLUDED.city,
       salary_from = EXCLUDED.salary_from, salary_to = EXCLUDED.salary_to,
       salary_currency = EXCLUDED.salary_currency, salary_gross = EXCLUDED.salary_gross,
       archived = EXCLUDED.archived,
       key_skills = CASE WHEN $18 THEN EXCLUDED.key_skills ELSE vacancies.key_skills END,
       description = CASE WHEN $18 THEN EXCLUDED.description ELSE vacancies.description END,
       raw = CASE WHEN $18 THEN EXCLUDED.raw ELSE vacancies.raw END,
       fetched_at = CASE WHEN $18 THEN now() ELSE vacancies.fetched_at END
     RETURNING id`,
    [
      v.id, v.name, v.employer?.name ?? null, v.area?.name ?? null,
      v.salary?.from ?? null, v.salary?.to ?? null, v.salary?.currency ?? null, v.salary?.gross ?? null,
      v.experience?.id ?? null, v.schedule?.id ?? null, v.employment?.id ?? null,
      (v.key_skills ?? []).map((s) => s.name),
      full ? stripHtml(v.description) : null,
      v.alternate_url, v.published_at ?? null, v.archived ?? false,
      full ? v : null, full,
    ],
  );
  return rows[0]!.id;
}

export interface VacancyCard {
  id: number;
  title: string;
  company: string | null;
  city: string | null;
  salary: { from: number | null; to: number | null; currency: string; gross: boolean | null } | null;
  schedule: string | null;
  experience: string | null;
  snippet: string;
  publishedAt: string | null;
}

const toCard = (id: number, v: HhItem): VacancyCard => ({
  id,
  title: v.name,
  company: v.employer?.name ?? null,
  city: v.area?.name ?? null,
  salary: v.salary ? { from: v.salary.from, to: v.salary.to, currency: v.salary.currency, gross: v.salary.gross ?? null } : null,
  schedule: v.schedule?.id ?? null,
  experience: v.experience?.id ?? null,
  snippet: stripHtml(v.snippet?.requirement || v.snippet?.responsibility).slice(0, 220),
  publishedAt: v.published_at ?? null,
});

export async function searchVacancies(p: SearchParams, dateFrom?: string) {
  const hhParams = {
    text: p.text,
    area: p.area,
    salary: p.salary,
    only_with_salary: p.onlyWithSalary || undefined,
    experience: p.experience,
    schedule: p.schedule,
    employment: p.employment,
    order_by: p.orderBy,
    page: p.page,
    per_page: 20,
    date_from: dateFrom,
  };
  const cacheKey = `hh:search:${createHash('sha1').update(JSON.stringify(hhParams)).digest('hex')}`;
  const cached = await kv.get(cacheKey);
  if (cached) return JSON.parse(cached) as { items: VacancyCard[]; found: number; pages: number; page: number };

  const data = await hhGet<{ items: HhItem[]; found: number; pages: number; page: number }>('/vacancies', hhParams);
  const items: VacancyCard[] = [];
  for (const v of data.items) items.push(toCard(await upsert(v), v));

  const result = { items, found: data.found, pages: data.pages, page: data.page };
  await kv.set(cacheKey, JSON.stringify(result), 600);
  return result;
}

/** Полная карточка. Описание из hh подтягивается лениво и обновляется раз в 6 часов. */
export async function getVacancy(id: number) {
  const { rows } = await query(`SELECT * FROM vacancies WHERE id = $1`, [id]);
  let v = rows[0];
  if (!v) throw new AppError(404, 'NOT_FOUND');
  const stale = !v.description || Date.now() - new Date(v.fetched_at).getTime() > 6 * 3600_000;
  if (v.source === 'hh' && stale) {
    try {
      await upsert(await hhGet<HhItem>(`/vacancies/${v.external_id}`));
      v = (await query(`SELECT * FROM vacancies WHERE id = $1`, [id])).rows[0];
    } catch (e) {
      if (!v.description) throw e; // нечего показать — пробрасываем
    }
  }
  return {
    id: v.id,
    title: v.title,
    company: v.company,
    city: v.city,
    salary: v.salary_from || v.salary_to
      ? { from: v.salary_from, to: v.salary_to, currency: v.salary_currency, gross: v.salary_gross }
      : null,
    experience: v.experience,
    schedule: v.schedule,
    employment: v.employment,
    keySkills: v.key_skills as string[],
    description: v.description as string,
    url: v.url,
    publishedAt: v.published_at,
    archived: v.archived,
  };
}
export type VacancyFull = Awaited<ReturnType<typeof getVacancy>>;

export async function suggestAreas(text: string) {
  const key = `hh:areas:${text.toLowerCase()}`;
  const cached = await kv.get(key);
  if (cached) return JSON.parse(cached) as { id: string; text: string }[];
  const data = await hhGet<{ items: { id: string; text: string }[] }>('/suggests/areas', { text });
  const items = data.items.slice(0, 10).map(({ id, text }) => ({ id, text }));
  await kv.set(key, JSON.stringify(items), 86400);
  return items;
}
