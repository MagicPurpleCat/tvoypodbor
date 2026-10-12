// Бот работает только через вебхук (POST /webhooks/telegram), без long polling.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile } from 'grammy';
import { config } from '../config.js';
import { render } from '../services/notify.js';

export const bot = new Bot(config.BOT_TOKEN);

const WELCOME_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/miniapp-cover.png');
// После первой загрузки Telegram отдаёт file_id — дальше шлём по нему, без повторной загрузки файла
let welcomeFileId: string | undefined;

bot.command('start', async (ctx) => {
  const { text, keyboard } = render('bot_start', {});
  try {
    const msg = await ctx.replyWithPhoto(welcomeFileId ?? new InputFile(WELCOME_IMAGE), {
      caption: text, parse_mode: 'HTML', reply_markup: keyboard,
    });
    welcomeFileId ??= msg.photo.at(-1)?.file_id;
  } catch (e) {
    // нет файла или Telegram не принял фото — приветствие всё равно должно дойти
    console.error('welcome photo', (e as Error).message);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }
});

bot.command(['help', 'support'], async (ctx) => {
  await ctx.reply('Вопросы и обращения — в разделе «Поддержка» приложения.', {
    reply_markup: { inline_keyboard: [[{ text: 'Поддержка', web_app: { url: `${config.WEBAPP_URL}?start=support` } }]] },
  });
});

bot.command('pro', async (ctx) => {
  await ctx.reply('Тарифы и статус подписки:', {
    reply_markup: { inline_keyboard: [[{ text: 'PRO-доступ', web_app: { url: `${config.WEBAPP_URL}?start=subscription` } }]] },
  });
});

bot.catch((err) => console.error('bot error', err.error));

/** Вызывается при старте: вебхук с секретом, кнопка меню и команды. Идемпотентно. */
export async function setupBot() {
  await bot.api.setWebhook(`${config.PUBLIC_URL}/webhooks/telegram`, {
    secret_token: config.BOT_WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
  });
  await bot.api.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'Вакансии', web_app: { url: config.WEBAPP_URL } },
  });
  await bot.api.setMyCommands([
    { command: 'start', description: 'Открыть ТвойПодбор' },
    { command: 'pro', description: 'Подписка PRO' },
    { command: 'support', description: 'Поддержка' },
  ]);
}
