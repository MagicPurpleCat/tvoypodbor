import copy from '@shared/copy.ru.json';

export { copy };

/** Подстановка {param} в строку. */
export const fmt = (s: string, params: Record<string, string | number> = {}) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));

export const B = copy.button_texts;
export const T = copy.screen_titles;
export const C = copy.screen_copy;
export const errorText = (code: string) =>
  (copy.error_messages as Record<string, string>)[code] ?? copy.error_messages.INTERNAL;

export const formatSalary = (s?: { from: number | null; to: number | null; currency: string | null } | null) => {
  if (!s || (!s.from && !s.to)) return C.salary_none;
  const n = (x: number) => x.toLocaleString('ru-RU');
  const cur = !s.currency || s.currency === 'RUR' ? '₽' : s.currency;
  if (s.from && s.to) return `${n(s.from)} – ${n(s.to)} ${cur}`;
  return s.from ? `от ${n(s.from)} ${cur}` : `до ${n(s.to!)} ${cur}`;
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
