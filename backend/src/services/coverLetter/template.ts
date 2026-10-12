// Бесплатный генератор без LLM: собирает отклик из резюме и пересечения навыков с вакансией.
import type { CoverLetterInput, CoverLetterProvider, Resume } from './types.js';

const months = (from: string, to: string | null) => {
  const [fy, fm] = from.split('-').map(Number);
  const end = to ? to.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1];
  return Math.max(0, (end[0]! - fy!) * 12 + (end[1]! - (fm ?? 1)));
};

const plural = (n: number, [one, few, many]: [string, string, string]) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export function totalExperience(r: Resume) {
  const total = r.experience.reduce((s, e) => s + months(e.from, e.to), 0);
  const y = Math.floor(total / 12), m = total % 12;
  if (!total) return '';
  if (!y) return `${m} ${plural(m, ['месяц', 'месяца', 'месяцев'])}`;
  // дробные годы в русском — всегда «года»: 1,5 года, 5,5 года
  return m >= 6 ? `${y},5 года` : `${y} ${plural(y, ['год', 'года', 'лет'])}`;
}

/** Навыки резюме, которые упоминаются в key_skills или тексте вакансии. */
export function matchSkills(r: Resume, vacancyText: string, keySkills: string[]) {
  const hay = (vacancyText + ' ' + keySkills.join(' ')).toLowerCase();
  return r.skills.filter((s) => s.trim() && hay.includes(s.toLowerCase().trim()));
}

export const templateProvider: CoverLetterProvider = {
  name: 'template',
  async generate({ vacancy: v, resume: r, tone }: CoverLetterInput) {
    const matched = matchSkills(r, v.description ?? '', v.keySkills);
    const skills = (matched.length ? matched : r.skills).slice(0, 6);
    const last = r.experience[0];
    const exp = totalExperience(r);
    const contacts = [r.contacts.phone, r.contacts.email, r.contacts.telegram].filter(Boolean).join(', ');
    const where = v.company ? ` в ${v.company}` : '';
    const greet = tone === 'friendly' ? 'Добрый день!' : 'Здравствуйте!';

    if (tone === 'short') {
      return [
        greet,
        `Откликаюсь на вакансию «${v.title}»${where}.`,
        [exp && `Опыт — ${exp}`, last && `последнее место: ${last.position}, ${last.company}`].filter(Boolean).join(', ') + '.',
        skills.length ? `Ключевые навыки: ${skills.join(', ')}.` : '',
        contacts ? `Контакты: ${contacts}.` : '',
        r.full_name,
      ].filter(Boolean).join('\n');
    }

    const points = [
      exp && last ? `${exp} опыта, последнее место — ${last.position} в ${last.company}` : '',
      skills.length ? `${matched.length ? 'Совпадение по требованиям' : 'Навыки'}: ${skills.join(', ')}` : '',
      last?.achievements ? `Результат на прошлом месте: ${last.achievements.trim().replace(/\.$/, '')}` : '',
      r.portfolio[0] ? `Примеры работ: ${r.portfolio.map((p) => p.url).slice(0, 2).join(', ')}` : '',
    ].filter(Boolean);

    return [
      greet,
      '',
      `Меня заинтересовала вакансия «${v.title}»${where}.` + (r.about ? ` ${r.about.trim().split(/(?<=\.)\s/)[0]}` : ''),
      '',
      points.length ? 'Почему я подхожу:\n' + points.map((p) => `• ${p}`).join('\n') : '',
      '',
      tone === 'friendly'
        ? 'Если откликается — давайте созвонимся, расскажу подробнее.'
        : 'Предлагаю созвониться и обсудить детали.',
      contacts ? `Контакты: ${contacts}` : '',
      '',
      tone === 'friendly' ? `Хорошего дня,\n${r.full_name}` : `С уважением,\n${r.full_name}`,
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').trim();
  },
};
