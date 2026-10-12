import { Router } from 'express';
import { z } from 'zod';
import { PLANS, PAYMENT_METHODS, type PlanId, type PaymentMethodKey } from '../config.js';
import { query } from '../db.js';
import { getQuota } from '../services/quota.js';
import { getTransaction } from '../services/platega.js';
import {
  applyPaymentStatus, createCheckout, getActiveSubscription, getPaymentStatus, getSubscriptionHistory,
} from '../services/subscription.js';

export const billingRouter = Router();

const plans = (Object.keys(PLANS) as PlanId[]).map((id) => ({
  id,
  ...PLANS[id],
  perDay: Math.round((PLANS[id].price / PLANS[id].days) * 10) / 10,
}));

billingRouter.get('/subscription', async (req, res) => {
  const [active, quota, history] = await Promise.all([
    getActiveSubscription(req.user.id),
    getQuota(req.user.id),
    getSubscriptionHistory(req.user.id),
  ]);
  res.json({ active, quota, plans, methods: Object.keys(PAYMENT_METHODS), history });
});

billingRouter.post('/subscription/checkout', async (req, res) => {
  const { plan, method } = z.object({
    plan: z.enum(Object.keys(PLANS) as [PlanId, ...PlanId[]]),
    method: z.enum(Object.keys(PAYMENT_METHODS) as [PaymentMethodKey, ...PaymentMethodKey[]]),
  }).parse(req.body);
  const { rows } = await query<{ username: string | null }>(`SELECT username FROM users WHERE id = $1`, [req.user.id]);
  const result = await createCheckout({ ...req.user, username: rows[0]?.username }, plan, method);
  res.status(201).json(result);
});

/** Опрос статуса из Mini App («Проверить оплату»). Если ещё pending — спрашиваем Platega напрямую. */
billingRouter.get('/subscription/payments/:id', async (req, res) => {
  const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
  let p = await getPaymentStatus(req.user.id, id);
  if (p.status === 'pending') {
    const { rows } = await query<{ provider_tx_id: string | null }>(
      `SELECT provider_tx_id FROM subscriptions WHERE id = $1`, [id]);
    const txId = rows[0]?.provider_tx_id;
    if (txId) {
      const t = await getTransaction(txId);
      if (t.status !== 'PENDING') {
        await applyPaymentStatus(txId, t.status);
        p = await getPaymentStatus(req.user.id, id);
      }
    }
  }
  res.json(p);
});
