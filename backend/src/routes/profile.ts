import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { getQuota } from '../services/quota.js';
import { getActiveSubscription } from '../services/subscription.js';

export const profileRouter = Router();

const ym = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/); // "2023-04"
const resumeSchema = z.object({
  full_name: z.string().trim().min(1).max(120),
  desired_position: z.string().trim().max(120).default(''),
  city: z.string().trim().max(80).nullable().default(null),
  contacts: z.object({
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().email().max(120).optional().or(z.literal('')),
    telegram: z.string().trim().max(64).optional(),
  }).default({}),
  experience: z.array(z.object({
    company: z.string().trim().min(1).max(120),
    position: z.string().trim().min(1).max(120),
    from: ym,
    to: ym.nullable(),
    achievements: z.string().trim().max(1000).optional(),
  })).max(15).default([]),
  skills: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
  education: z.array(z.object({
    institution: z.string().trim().min(1).max(160),
    degree: z.string().trim().max(120).optional(),
    year: z.number().int().min(1950).max(2100).optional(),
  })).max(10).default([]),
  portfolio: z.array(z.object({
    title: z.string().trim().min(1).max(80),
    url: z.string().url().max(300).refine((u) => /^https?:/.test(u)),
  })).max(10).default([]),
  about: z.string().trim().max(1500).default(''),
});

/** Профиль: пользователь, лимит, подписка, статистика пути. */
profileRouter.get('/me', async (req, res) => {
  const uid = req.user.id;
  const [user, quota, subscription, stats, funnel] = await Promise.all([
    query(`SELECT telegram_id, username, first_name, notify_new_vacancies, notify_reminders, created_at
           FROM users WHERE id = $1`, [uid]),
    getQuota(uid),
    getActiveSubscription(uid),
    query(
      `WITH decisions AS (
         SELECT DISTINCT ON (vacancy_id) action FROM user_actions
         WHERE user_id = $1 AND action IN ('accept', 'reject') ORDER BY vacancy_id, created_at DESC)
       SELECT
         (SELECT count(*) FROM decisions WHERE action = 'accept')::int AS accepted,
         (SELECT count(*) FROM decisions WHERE action = 'reject')::int AS rejected,
         (SELECT count(*) FROM favorites WHERE user_id = $1)::int AS favorites,
         (SELECT count(DISTINCT vacancy_id) FROM user_actions WHERE user_id = $1 AND action = 'apply')::int AS applied,
         (SELECT count(DISTINCT vacancy_id) FROM user_actions WHERE user_id = $1 AND action = 'view')::int AS viewed,
         (SELECT count(*) FROM user_actions WHERE user_id = $1 AND action = 'generate_letter')::int AS letters`,
      [uid],
    ),
    // Воронка откликов: последний статус по каждой вакансии
    query(
      `SELECT status, count(*)::int AS count FROM (
         SELECT DISTINCT ON (vacancy_id) status FROM user_actions
         WHERE user_id = $1 AND action IN ('apply', 'status_change') ORDER BY vacancy_id, created_at DESC) t
       GROUP BY status`,
      [uid],
    ),
  ]);
  res.json({
    user: user.rows[0],
    quota,
    subscription,
    stats: { ...stats.rows[0], funnel: Object.fromEntries(funnel.rows.map((r) => [r.status, r.count])) },
  });
});

profileRouter.patch('/me/settings', async (req, res) => {
  const s = z.object({ notify_new_vacancies: z.boolean().optional(), notify_reminders: z.boolean().optional() }).parse(req.body);
  await query(
    `UPDATE users SET notify_new_vacancies = coalesce($2, notify_new_vacancies),
       notify_reminders = coalesce($3, notify_reminders) WHERE id = $1`,
    [req.user.id, s.notify_new_vacancies ?? null, s.notify_reminders ?? null],
  );
  res.status(204).end();
});

profileRouter.get('/resume', async (req, res) => {
  const { rows } = await query(
    `SELECT full_name, desired_position, city, contacts, experience, skills, education, portfolio, about, updated_at
     FROM user_resumes WHERE user_id = $1`,
    [req.user.id],
  );
  res.json({ resume: rows[0] ?? null });
});

profileRouter.put('/resume', async (req, res) => {
  const r = resumeSchema.parse(req.body);
  // опыт — от нового к старому: генератор берёт experience[0] как последнее место
  r.experience.sort((a, b) => (b.to ?? '9999').localeCompare(a.to ?? '9999') || b.from.localeCompare(a.from));
  const { rows } = await query(
    `INSERT INTO user_resumes (user_id, full_name, desired_position, city, contacts, experience, skills, education, portfolio, about)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       full_name = EXCLUDED.full_name, desired_position = EXCLUDED.desired_position, city = EXCLUDED.city,
       contacts = EXCLUDED.contacts, experience = EXCLUDED.experience, skills = EXCLUDED.skills,
       education = EXCLUDED.education, portfolio = EXCLUDED.portfolio, about = EXCLUDED.about, updated_at = now()
     RETURNING updated_at`,
    [req.user.id, r.full_name, r.desired_position, r.city, JSON.stringify(r.contacts), JSON.stringify(r.experience),
     r.skills, JSON.stringify(r.education), JSON.stringify(r.portfolio), r.about],
  );
  res.json({ resume: { ...r, updated_at: rows[0]!.updated_at } });
});

/** История действий, пагинация курсором по id. */
profileRouter.get('/history', async (req, res) => {
  const { cursor, limit } = z.object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }).parse(req.query);
  const { rows } = await query(
    `SELECT a.id, a.action, a.status, a.meta, a.created_at,
            v.id AS vacancy_id, v.title, v.company
     FROM user_actions a LEFT JOIN vacancies v ON v.id = a.vacancy_id
     WHERE a.user_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
     ORDER BY a.id DESC LIMIT $3`,
    [req.user.id, cursor ?? null, limit],
  );
  res.json({ items: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null });
});
