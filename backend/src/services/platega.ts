// Клиент Platega.io. Документация: https://docs.platega.io
// Авторизация всех запросов — заголовки X-MerchantId + X-Secret.
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

export type PlategaStatus = 'PENDING' | 'CONFIRMED' | 'CANCELED' | 'CHARGEBACKED';

export interface CreateTransactionInput {
  paymentMethod: number; // 2 СБП QR, 11 карты РФ, 13 крипта, 14 SberPay
  amount: number;
  currency: 'RUB';
  description: string;
  returnUrl: string; // куда вернуть после успешной оплаты
  failedUrl: string;
  orderId: string; // наш subscriptions.id
  payload?: string; // вернётся в статусе транзакции
  userId: string; // metadata.userId — нужен антифроду Platega
  userName?: string;
}

export interface CreateTransactionResult {
  transactionId: string;
  redirect: string; // ссылка на форму оплаты
  status: PlategaStatus;
  expiresIn?: string; // "HH:MM:SS"
}

export interface TransactionInfo {
  id: string;
  status: PlategaStatus;
  paymentDetails?: { amount: number; currency: string } | string;
  payload?: string;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const { PLATEGA_MERCHANT_ID: merchantId, PLATEGA_SECRET: secret } = config;
  if (!merchantId || !secret) {
    console.error('Platega не настроена: заполните PLATEGA_MERCHANT_ID и PLATEGA_SECRET в .env');
    throw new AppError(503, 'PAYMENT_FAILED', 'Payments are not configured');
  }
  const res = await fetch(`${config.PLATEGA_BASE_URL}${path}`, {
    method,
    headers: {
      'X-MerchantId': merchantId,
      'X-Secret': secret,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`platega ${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    throw new AppError(502, 'PAYMENT_FAILED', 'Payment provider error');
  }
  return (await res.json()) as T;
}

/** POST /transaction/process — создать платёж, получить ссылку на оплату. */
export function createTransaction(i: CreateTransactionInput) {
  return call<CreateTransactionResult>('POST', '/transaction/process', {
    paymentMethod: i.paymentMethod,
    paymentDetails: { amount: i.amount, currency: i.currency },
    description: i.description,
    return: i.returnUrl,
    failedUrl: i.failedUrl,
    orderId: i.orderId,
    payload: i.payload,
    metadata: { userId: i.userId, userName: i.userName ?? '' },
  });
}

/** GET /transaction/{id} — актуальный статус (повторная проверка вебхука и опрос «зависших» платежей). */
export function getTransaction(id: string) {
  return call<TransactionInfo>('GET', `/transaction/${encodeURIComponent(id)}`);
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Callback Platega приходит с теми же X-MerchantId / X-Secret.
 * Этого недостаточно как единственной защиты, поэтому обработчик вебхука
 * дополнительно перезапрашивает статус через getTransaction().
 */
export function verifyCallbackHeaders(merchantId?: string, secret?: string) {
  const { PLATEGA_MERCHANT_ID: m, PLATEGA_SECRET: s } = config;
  return Boolean(m && s && merchantId && secret && eq(merchantId, m) && eq(secret, s));
}
