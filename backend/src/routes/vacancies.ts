import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { AppError } from '../errors.js';
import { requireQuota } from '../middleware/quota.js';
import { getVacancy, searchSchema, searchVacancies, suggestAreas } from '../services/hh.js';
import { generateCoverLetter, type Resume } from '../services/coverLetter/index.js';

export const vacanciesRouter = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });
const logAction = (userId: number, vacancyId: number | null, action: string, status?: string, meta: object = {}) =>
  query(`INSERT INTO user_actions (user_id, vacancy_id, action, status, meta) VALUES ($1, $2, $3, $4, $5)`,
    [userId, vacancyId, action, status ?? null, meta]);

/** Поиск. В лимит идёт только новый поиск (page = 0); листание бесплатно. */
vacanciesRouter.get(
  '/vacancies/search',
  requireQuota((req) => !Number(req.query.page)),
  async (req, res) => {
    const params = searchSchema.parse(req.query);
    const result = await searchVacancies(params);
    if (params.page === 0) {
      const { page: _p, ...saved } = params;
      await query(`UPDATE users SET saved_search = $2 WHERE id = $1`, [req.user.id, saved]);
      await logAction(req.user.id, null, 'search', undefined, { text: params.text, found: result.found });
    }
    res.json(result);
  },
);

vacanciesRouter.get('/areas', async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query);
  res.json({ items: await suggestAreas(q) });
});

vacanciesRouter.get('/vacancies/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const vacancy = await getVacancy(id);
  const [, fav, last] = await Promise.all([
    logAction(req.user.id, id, 'view'),
    query(`SELECT 1 FROM favorites WHERE user_id = $1 AND vacancy_id = $2`, [req.user.id, id]),
    query(`SELECT action, status FROM user_actions WHERE user_id = $1 AND vacancy_id = $2
           AND action IN ('accept', 'reject', 'apply', 'status_change') ORDER BY created_at DESC LIMIT 1`, [req.user.id, id]),
  ]);
  res.json({ vacancy, isFavorite: Boolean(fav.rowCount), lastAction: last.rows[0] ?? null });
});

/** «Подходит» / «Не моё» — источник статистики «принято / отклонено». */
vacanciesRouter.post('/vacancies/:id/decision', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { decision } = z.object({ decision: z.enum(['accept', 'reject']) }).parse(req.body);
  await logAction(req.user.id, id, decision);
  res.status(204).end();
});

/** Статус отклика, который пользователь ведёт сам: applied → invited → interview → offer | declined. */
vacanciesRouter.post('/vacancies/:id/status', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { status } = z.object({ status: z.enum(['applied', 'invited', 'interview', 'offer', 'declined']) }).parse(req.body);
  await logAction(req.user.id, id, status === 'applied' ? 'apply' : 'status_change', status);
  res.status(204).end();
});

// ---- Избранное ----
vacanciesRouter.get('/favorites', async (req, res) => {
  const { rows } = await query(
    `SELECT v.id, v.title, v.company, v.city, v.salary_from, v.salary_to, v.salary_currency, v.archived,
            f.note, f.created_at AS added_at
     FROM favorites f JOIN vacancies v ON v.id = f.vacancy_id
     WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
    [req.user.id],
  );
  res.json({ items: rows });
});

vacanciesRouter.put('/favorites/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
  const { rowCount } = await query(
    `INSERT INTO favorites (user_id, vacancy_id, note) SELECT $1, id, $3 FROM vacancies WHERE id = $2
     ON CONFLICT (user_id, vacancy_id) DO UPDATE SET note = coalesce(EXCLUDED.note, favorites.note)`,
    [req.user.id, id, note ?? null],
  );
  if (!rowCount) throw new AppError(404, 'NOT_FOUND');
  await logAction(req.user.id, id, 'favorite');
  res.status(204).end();
});

vacanciesRouter.delete('/favorites/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { rowCount } = await query(`DELETE FROM favorites WHERE user_id = $1 AND vacancy_id = $2`, [req.user.id, id]);
  if (rowCount) await logAction(req.user.id, id, 'unfavorite');
  res.status(204).end();
});

// ---- Генератор отклика ----
const coverSchema = z.object({
  vacancyId: z.number().int().positive(),
  tone: z.enum(['formal', 'friendly', 'short']).default('formal'),
});

// Резюме проверяем ДО списания лимита, чтобы не сжечь запрос на пустом профиле.
const loadResume: RequestHandler = async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM user_resumes WHERE user_id = $1`, [req.user.id]);
    const r = rows[0] as Resume | undefined;
    if (!r || !r.full_name || (!r.experience.length && !r.skills.length)) throw new AppError(409, 'RESUME_REQUIRED');
    res.locals.resume = r;
    next();
  } catch (e) {
    next(e);
  }
};

vacanciesRouter.post('/cover-letter', loadResume, requireQuota(), async (req, res) => {
  const { vacancyId, tone } = coverSchema.parse(req.body);
  const vacancy = await getVacancy(vacancyId);
  const { text, provider } = await generateCoverLetter({ vacancy, resume: res.locals.resume as Resume, tone });
  await logAction(req.user.id, vacancyId, 'generate_letter', undefined, { tone, provider });
  res.json({ text, provider, vacancyUrl: vacancy.url });
});
