// Уведомления: запись в outbox-таблицу notifications. Отправляет jobs/notificationWorker.
import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { query } from '../db.js';
import { copy } from '../copy.js';

export type NotificationType = keyof typeof copy.notification_templates & string;

export async function enqueue(
  userId: number,
  type: NotificationType,
  payload: Record<string, unknown>,
  opts: { dedupKey?: string; scheduledAt?: Date } = {},
) {
  await query(
    `INSERT INTO notifications (user_id, type, payload, dedup_key, scheduled_at)
     VALUES ($1, $2, $3, $4, coalesce($5, now()))
     ON CONFLICT (dedup_key) DO NOTHING`,
    [userId, type, payload, opts.dedupKey ?? null, opts.scheduledAt ?? null],
  );
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) + ' МСК';

// Поля, которые уже собраны как безопасный HTML (например, список вакансий из планировщика).
const RAW_HTML_KEYS = new Set(['list']);

export function render(type: string, payload: Record<string, unknown>) {
  const tpl = copy.notification_templates[type];
  if (!tpl) throw new Error(`Unknown notification type: ${type}`);
  const sub = (s: string) =>
    s.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = payload[k];
      if (v === undefined || v === null) return '';
      const str = k.endsWith('At') && typeof v === 'string' ? fmtDate(v) : String(v);
      return RAW_HTML_KEYS.has(k) ? str : escapeHtml(str);
    });

  const keyboard = new InlineKeyboard();
  for (const b of tpl.buttons) {
    // web_app-кнопка открывает Mini App; экран передаём через ?start=, т.к. start_param тут не приходит
    keyboard.webApp(sub(b.text), `${config.WEBAPP_URL}?start=${encodeURIComponent(sub(b.start))}`).row();
  }
  return { text: sub(tpl.text), keyboard: tpl.buttons.length ? keyboard : undefined };
}
