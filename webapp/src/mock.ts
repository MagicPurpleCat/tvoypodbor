// Моки API для вёрстки вне Telegram (npm run dev → открыть в браузере). В прод-сборку не попадают по логике api.ts.
import copy from '@shared/copy.ru.json';

let used = 3;
const favs = new Set<number>([2]);
const resetAt = () => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
};
const quota = () => ({ unlimited: false, limit: 5, used, remaining: Math.max(0, 5 - used), resetAt: resetAt() });

const cards = [
  { id: 1, title: 'Frontend-разработчик (React)', company: 'Ozon Tech', city: 'Москва', salary: { from: 250000, to: 350000, currency: 'RUR' }, schedule: 'remote', experience: 'between3And6', snippet: 'React, TypeScript, опыт с дизайн-системами. Код-ревью, менторство.', publishedAt: new Date().toISOString() },
  { id: 2, title: 'Node.js Backend Engineer', company: 'Тинькофф', city: 'Санкт-Петербург', salary: { from: 300000, to: null, currency: 'RUR' }, schedule: 'flexible', experience: 'between3And6', snippet: 'Node.js, PostgreSQL, Kafka. Высоконагруженные сервисы платежей.', publishedAt: new Date().toISOString() },
  { id: 3, title: 'Продуктовый дизайнер', company: 'Avito', city: 'Москва', salary: null, schedule: 'fullDay', experience: 'between1And3', snippet: 'Figma, исследования, работа с метриками продукта.', publishedAt: new Date().toISOString() },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  await sleep(250);
  const { ApiError, limitEvents } = await import('./api');
  const spend = () => {
    if (used >= 5) {
      const data = { code: 'LIMIT_EXCEEDED', limit: 5, resetAt: resetAt() };
      limitEvents.dispatchEvent(new CustomEvent('limit', { detail: data }));
      throw new ApiError(402, 'LIMIT_EXCEEDED', data);
    }
    used++;
  };
  if (path.startsWith('/vacancies/search')) {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 0);
    if (!page) spend();
    return { items: cards, found: 1284, pages: 20, page };
  }
  const vac = path.match(/^\/vacancies\/(\d+)$/);
  if (vac) {
    const c = cards.find((x) => x.id === Number(vac[1])) ?? cards[0]!;
    return {
      vacancy: { ...c, employment: 'full', keySkills: ['React', 'TypeScript', 'Redux', 'Webpack'], description: c.snippet + '\n\nОбязанности:\n• разработка интерфейсов\n• код-ревью\n\nУсловия:\n• удалёнка\n• ДМС', url: 'https://hh.ru/vacancy/1', archived: false },
      isFavorite: favs.has(c.id), lastAction: null,
    };
  }
  if (path.startsWith('/favorites/')) {
    const id = Number(path.split('/')[2]);
    method === 'DELETE' ? favs.delete(id) : favs.add(id);
    return undefined;
  }
  if (path === '/favorites') {
    return { items: cards.filter((c) => favs.has(c.id)).map((c) => ({ ...c, salary_from: c.salary?.from ?? null, salary_to: c.salary?.to ?? null, salary_currency: 'RUR', archived: false, added_at: new Date().toISOString() })) };
  }
  if (path === '/me') {
    return { user: { first_name: 'Алекс', username: 'alex', created_at: '2026-09-01' }, quota: quota(), subscription: null,
      stats: { accepted: 14, rejected: 31, favorites: favs.size, applied: 9, viewed: 76, letters: 11, funnel: { applied: 6, invited: 2, interview: 1 } } };
  }
  if (path === '/resume' && method === 'GET') {
    return { resume: { full_name: 'Алекс Смирнов', desired_position: 'Frontend-разработчик', city: 'Москва', contacts: { telegram: '@alex', email: 'alex@example.com' },
      experience: [{ company: 'Skyeng', position: 'Frontend-разработчик', from: '2022-03', to: null, achievements: 'Ускорил загрузку личного кабинета в 2 раза' }],
      skills: ['React', 'TypeScript', 'Redux'], education: [], portfolio: [{ title: 'GitHub', url: 'https://github.com/alex' }], about: 'Делаю быстрые интерфейсы.' } };
  }
  if (path === '/resume') return { resume: body };
  if (path === '/cover-letter') {
    spend();
    return { text: 'Здравствуйте!\n\nМеня заинтересовала вакансия «Frontend-разработчик (React)» в Ozon Tech.\n\nПочему я подхожу:\n• 4,5 года опыта, последнее место — Frontend-разработчик в Skyeng\n• Совпадение по требованиям: React, TypeScript\n\nПредлагаю созвониться и обсудить детали.\nКонтакты: @alex\n\nС уважением,\nАлекс Смирнов', provider: 'template', vacancyUrl: 'https://hh.ru' };
  }
  if (path.startsWith('/history')) {
    return { items: [
      { id: 3, action: 'generate_letter', status: null, meta: {}, created_at: new Date().toISOString(), vacancy_id: 1, title: cards[0]!.title, company: cards[0]!.company },
      { id: 2, action: 'apply', status: 'applied', meta: {}, created_at: new Date().toISOString(), vacancy_id: 2, title: cards[1]!.title, company: cards[1]!.company },
      { id: 1, action: 'view', status: null, meta: {}, created_at: new Date().toISOString(), vacancy_id: 3, title: cards[2]!.title, company: cards[2]!.company },
    ], nextCursor: null };
  }
  if (path === '/subscription') {
    return { active: null, quota: quota(), methods: ['sbp', 'card', 'crypto'], plans: [
      { id: 'week', title: 'Неделя', days: 7, price: 149, perDay: 21.3 },
      { id: 'month', title: 'Месяц', days: 30, price: 399, perDay: 13.3 },
      { id: 'quarter', title: '3 месяца', days: 90, price: 990, perDay: 11 },
    ] };
  }
  if (path === '/subscription/checkout') return { subscriptionId: 1, paymentUrl: 'https://pay.platega.io', expiresIn: '00:15:00' };
  if (path.startsWith('/subscription/payments/')) return { id: 1, status: 'pending', expires_at: null };
  if (path === '/support/faq') return { items: copy.faq };
  if (path === '/support/tickets') return { id: 101 };
  return undefined;
}
