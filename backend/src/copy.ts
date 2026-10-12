// Тексты из shared/copy.ru.json — общие для бота, API (FAQ) и Mini App.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/copy.ru.json');

export interface NotificationTemplate {
  text: string;
  buttons: { text: string; start: string }[];
}

export const copy = JSON.parse(readFileSync(file, 'utf8')) as {
  notification_templates: Record<string, NotificationTemplate>;
  faq: { q: string; a: string }[];
  error_messages: Record<string, string>;
};
