import { useEffect, useState } from 'react';
import { api, type Resume as R } from '../api';
import { B, T, errorText } from '../copy';
import { useNav } from '../nav';
import { alert, haptic, tg } from '../tg';
import { BottomCta, ErrorBox, Skeleton } from '../components/ui';
import { ApiError } from '../api';

const EMPTY: R = { full_name: '', desired_position: '', city: null, contacts: {}, experience: [], skills: [], education: [], portfolio: [], about: '' };

function Field({ label, ...p }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <div><label className="label">{label}</label><input className="input" {...p} /></div>;
}

export function Resume() {
  const { back } = useNav();
  const [r, setR] = useState<R | null>(null);
  const [skillsText, setSkillsText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.resume().then(({ resume }) => {
      const v = resume ?? { ...EMPTY, full_name: tg?.initDataUnsafe.user?.first_name ?? '' };
      setR(v);
      setSkillsText(v.skills.join(', '));
    }).catch(setError);
  }, []);

  // защита от потери несохранённых правок при закрытии Mini App
  useEffect(() => {
    if (!tg) return;
    dirty ? tg.enableClosingConfirmation() : tg.disableClosingConfirmation();
    return () => tg!.disableClosingConfirmation();
  }, [dirty]);

  if (error && !r) return <ErrorBox error={error} />;
  if (!r) return <Skeleton h={60} n={5} />;

  const upd = (patch: Partial<R>) => { setR({ ...r, ...patch }); setDirty(true); };
  const updList = <K extends 'experience' | 'education' | 'portfolio'>(k: K, i: number, patch: Partial<R[K][number]>) =>
    upd({ [k]: r[k].map((x, j) => (j === i ? { ...x, ...patch } : x)) } as Partial<R>);
  const removeAt = (k: 'experience' | 'education' | 'portfolio', i: number) => upd({ [k]: r[k].filter((_, j) => j !== i) } as Partial<R>);

  async function save() {
    setSaving(true);
    try {
      const payload = {
        ...r!,
        skills: skillsText.split(',').map((s) => s.trim()).filter(Boolean),
        contacts: Object.fromEntries(Object.entries(r!.contacts).filter(([, v]) => v)),
        experience: r!.experience.map((e) => ({ ...e, to: e.to || null })),
      };
      await api.saveResume(payload);
      setDirty(false);
      haptic.success();
      back();
    } catch (e) {
      haptic.error();
      await alert(e instanceof ApiError ? errorText(e.code) : errorText('INTERNAL'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="stack">
      <h1>{T.resume}</h1>

      <div className="card stack">
        <Field label="Имя и фамилия" value={r.full_name} onChange={(e) => upd({ full_name: e.target.value })} />
        <Field label="Желаемая должность" value={r.desired_position} onChange={(e) => upd({ desired_position: e.target.value })} />
        <Field label="Город" value={r.city ?? ''} onChange={(e) => upd({ city: e.target.value || null })} />
      </div>

      <div className="card stack">
        <h3>Контакты</h3>
        <Field label="Телефон" inputMode="tel" value={r.contacts.phone ?? ''} onChange={(e) => upd({ contacts: { ...r.contacts, phone: e.target.value } })} />
        <Field label="Email" inputMode="email" value={r.contacts.email ?? ''} onChange={(e) => upd({ contacts: { ...r.contacts, email: e.target.value } })} />
        <Field label="Telegram" value={r.contacts.telegram ?? ''} placeholder="@username" onChange={(e) => upd({ contacts: { ...r.contacts, telegram: e.target.value } })} />
      </div>

      <div className="card stack">
        <h3>Опыт</h3>
        {r.experience.map((e, i) => (
          <div key={i} className="stack" style={{ gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
            <Field label="Компания" value={e.company} onChange={(ev) => updList('experience', i, { company: ev.target.value })} />
            <Field label="Должность" value={e.position} onChange={(ev) => updList('experience', i, { position: ev.target.value })} />
            <div className="row">
              <div className="grow"><Field label="С" type="month" value={e.from} onChange={(ev) => updList('experience', i, { from: ev.target.value })} /></div>
              <div className="grow"><Field label="По (пусто — сейчас)" type="month" value={e.to ?? ''} onChange={(ev) => updList('experience', i, { to: ev.target.value || null })} /></div>
            </div>
            <div><label className="label">Достижения</label>
              <textarea className="textarea" style={{ minHeight: 70 }} value={e.achievements ?? ''} placeholder="Цифры и результат: «время ответа API: 800 → 120 мс»"
                onChange={(ev) => updList('experience', i, { achievements: ev.target.value })} /></div>
            <button className="btn btn-ghost sm" onClick={() => removeAt('experience', i)}>Удалить</button>
          </div>
        ))}
        <button className="btn btn-ghost sm" onClick={() => upd({ experience: [...r.experience, { company: '', position: '', from: '', to: null }] })}>{B.add_experience}</button>
      </div>

      <div className="card stack">
        <h3>Навыки</h3>
        <input className="input" value={skillsText} placeholder="React, TypeScript, SQL" onChange={(e) => { setSkillsText(e.target.value); setDirty(true); }} />
      </div>

      <div className="card stack">
        <h3>Образование</h3>
        {r.education.map((e, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <div className="grow"><Field label="Учебное заведение" value={e.institution} onChange={(ev) => updList('education', i, { institution: ev.target.value })} /></div>
            <div style={{ width: 90 }}><Field label="Год" inputMode="numeric" value={e.year ?? ''} onChange={(ev) => updList('education', i, { year: Number(ev.target.value) || undefined })} /></div>
            <button className="btn btn-ghost sm" onClick={() => removeAt('education', i)}>✕</button>
          </div>
        ))}
        <button className="btn btn-ghost sm" onClick={() => upd({ education: [...r.education, { institution: '' }] })}>{B.add_education}</button>
      </div>

      <div className="card stack">
        <h3>Портфолио</h3>
        {r.portfolio.map((p, i) => (
          <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ width: 110 }}><Field label="Название" value={p.title} onChange={(ev) => updList('portfolio', i, { title: ev.target.value })} /></div>
            <div className="grow"><Field label="Ссылка" inputMode="url" value={p.url} placeholder="https://" onChange={(ev) => updList('portfolio', i, { url: ev.target.value })} /></div>
            <button className="btn btn-ghost sm" onClick={() => removeAt('portfolio', i)}>✕</button>
          </div>
        ))}
        <button className="btn btn-ghost sm" onClick={() => upd({ portfolio: [...r.portfolio, { title: '', url: '' }] })}>{B.add_portfolio}</button>
      </div>

      <div className="card stack">
        <h3>О себе</h3>
        <textarea className="textarea" value={r.about} maxLength={1500} placeholder="2–3 предложения: чем занимаетесь и что ищете"
          onChange={(e) => upd({ about: e.target.value })} />
      </div>

      <BottomCta text={B.save_resume} onClick={save} loading={saving} disabled={!r.full_name.trim()} />
    </div>
  );
}
