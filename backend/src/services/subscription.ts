import { PLANS, PAYMENT_METHODS, webAppLink, type PlanId, type PaymentMethodKey } from '../config.js';
import { query, tx } from '../db.js';
import { kv } from '../redis.js';
import { AppError } from '../errors.js';
import { createTransaction, type PlategaStatus } from './platega.js';
import { enqueue } from './notify.js';

export interface ActiveSubscription {
  plan: PlanId;
  expiresAt: string; // до какого момента оплачено (с учётом продлений)
}

const cacheKey = (userId: number) => `sub:${userId}`;

export async function getActiveSubscription(userId: number): Promise<ActiveSubscription | null> {
  const cached = await kv.get(cacheKey(userId));
  if (cached) return cached === 'none' ? null : (JSON.parse(cached) as ActiveSubscription);

  const { rows } = await query<{ plan: PlanId; paid_until: Date }>(
    `SELECT
       (SELECT plan FROM subscriptions s2 WHERE s2.user_id = $1 AND s2.status = 'active'
          AND now() BETWEEN s2.starts_at AND s2.expires_at LIMIT 1) AS plan,
       max(expires_at) AS paid_until
     FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
    [userId],
  );
  const r = rows[0];
  const sub = r?.plan && r.paid_until ? { plan: r.plan, expiresAt: r.paid_until.toISOString() } : null;
  await kv.set(cacheKey(userId), sub ? JSON.stringify(sub) : 'none', 60);
  return sub;
}

export const invalidateSubscription = (userId: number) => kv.del(cacheKey(userId));

export async function createCheckout(
  user: { id: number; telegramId: number; username?: string | null },
  plan: PlanId,
  method: PaymentMethodKey,
) {
  const p = PLANS[plan];
  const { rows } = await query<{ id: number }>(
    `INSERT INTO subscriptions (user_id, plan, amount, payment_method) VALUES ($1, $2, $3, $4) RETURNING id`,
    [user.id, plan, p.price, PAYMENT_METHODS[method]],
  );
  const subId = rows[0]!.id;

  try {
    const t = await createTransaction({
      paymentMethod: PAYMENT_METHODS[method],
      amount: p.price,
      currency: 'RUB',
      description: `ТвойПодбор PRO — ${p.title}`,
      returnUrl: webAppLink(`paid_${subId}`),
      failedUrl: webAppLink(`payfail_${subId}`),
      orderId: String(subId),
      payload: String(subId),
      userId: String(user.telegramId),
      userName: user.username ? `@${user.username}` : undefined,
    });
    await query(
      `UPDATE subscriptions SET provider_tx_id = $2, provider_status = $3, payment_url = $4, updated_at = now() WHERE id = $1`,
      [subId, t.transactionId, t.status, t.redirect],
    );
    return { subscriptionId: subId, paymentUrl: t.redirect, expiresIn: t.expiresIn ?? null };
  } catch (e) {
    await query(`UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1`, [subId]);
    throw e;
  }
}

/**
 * Применить статус Platega к подписке. Идемпотентно: повторный CONFIRMED ничего не меняет.
 * Новая подписка начинается после окончания текущей (продление стакается).
 */
export async function applyPaymentStatus(transactionId: string, status: PlategaStatus) {
  const changed = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, user_id, plan, status FROM subscriptions WHERE provider_tx_id = $1 FOR UPDATE`,
      [transactionId],
    );
    const sub = rows[0] as { id: number; user_id: number; plan: PlanId; status: string } | undefined;
    if (!sub) throw new AppError(404, 'NOT_FOUND', 'Unknown transaction');

    await c.query(`UPDATE subscriptions SET provider_status = $2, updated_at = now() WHERE id = $1`, [sub.id, status]);

    if (status === 'CONFIRMED' && sub.status === 'pending') {
      // Блокируем все подписки пользователя, чтобы параллельные оплаты не наложились.
      await c.query(`SELECT 1 FROM subscriptions WHERE user_id = $1 FOR UPDATE`, [sub.user_id]);
      const { rows: base } = await c.query(
        `SELECT greatest(now(), coalesce(max(expires_at), now())) AS starts_at
         FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
        [sub.user_id],
      );
      const { rows: upd } = await c.query(
        `UPDATE subscriptions SET status = 'active', starts_at = $2,
           expires_at = $2::timestamptz + make_interval(days => $3), updated_at = now()
         WHERE id = $1 RETURNING expires_at`,
        [sub.id, base[0].starts_at, PLANS[sub.plan].days],
      );
      return { userId: sub.user_id, event: 'payment_success' as const, plan: sub.plan, expiresAt: upd[0].expires_at as Date };
    }
    if (status === 'CANCELED' && sub.status === 'pending') {
      await c.query(`UPDATE subscriptions SET status = 'canceled' WHERE id = $1`, [sub.id]);
      return { userId: sub.user_id, event: 'payment_failed' as const, plan: sub.plan };
    }
    if (status === 'CHARGEBACKED' && sub.status === 'active') {
      await c.query(`UPDATE subscriptions SET status = 'refunded', expires_at = now() WHERE id = $1`, [sub.id]);
      return { userId: sub.user_id, event: 'subscription_revoked' as const, plan: sub.plan };
    }
    return null;
  });

  if (!changed) return;
  await invalidateSubscription(changed.userId);
  await enqueue(changed.userId, changed.event, {
    plan: PLANS[changed.plan].title,
    expiresAt: changed.event === 'payment_success' ? changed.expiresAt.toISOString() : undefined,
  }, { dedupKey: `${changed.event}:${transactionId}` });
}

export async function getSubscriptionHistory(userId: number) {
  const { rows } = await query(
    `SELECT id, plan, status, amount, currency, starts_at, expires_at, created_at
     FROM subscriptions WHERE user_id = $1 AND status <> 'pending' ORDER BY created_at DESC LIMIT 20`,
    [userId],
  );
  return rows;
}

export async function getPaymentStatus(userId: number, subId: number) {
  const { rows } = await query(
    `SELECT id, plan, status, provider_status, expires_at FROM subscriptions WHERE id = $1 AND user_id = $2`,
    [subId, userId],
  );
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND');
  return rows[0];
}
