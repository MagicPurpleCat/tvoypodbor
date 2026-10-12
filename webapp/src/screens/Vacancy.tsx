import { useEffect, useState } from 'react';
import { api, type Vacancy as V } from '../api';
import { B, C, formatSalary } from '../copy';
import { useNav } from '../nav';
import { haptic, openLink } from '../tg';
import { BottomCta, ErrorBox, Skeleton } from '../components/ui';

const STATUSES = [
  ['applied', 'Отклик отправлен'], ['invited', 'Пригласили'], ['interview', 'Собеседование'],
  ['offer', 'Оффер'], ['declined', 'Отказ'],
] as const;

export function Vacancy({ id }: { id: number }) {
  const { push } = useNav();
  const [v, setV] = useState<V | null>(null);
  const [fav, setFav] = useState(false);
  const [decision, setDecision] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState(false);

  const load = () => {
    setError(null);
    api.vacancy(id).then((r) => {
      setV(r.vacancy);
      setFav(r.isFavorite);
      if (r.lastAction?.action === 'accept' || r.lastAction?.action === 'reject') setDecision(r.lastAction.action);
      if (r.lastAction?.status) setStatus(r.lastAction.status);
    }).catch(setError);
  };
  useEffect(load, [id]);

  const toggleFav = async () => {
    haptic.tap();
    setFav(!fav); // оптимистично
    try { fav ? await api.removeFavorite(id) : await api.addFavorite(id); } catch { setFav(fav); }
  };
  const decide = async (d: 'accept' | 'reject') => {
    haptic.select();
    setDecision(d);
    await api.decide(id, d).catch(() => setDecision(null));
  };
  const changeStatus = async (s: string) => {
    haptic.select();
    setStatus(s);
    await api.setStatus(id, s).catch(() => setStatus(null));
  };

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!v) return <Skeleton h={160} n={2} />;

  const desc = v.description ?? '';
  const long = desc.length > 600;

  return (
    <div className="stack">
      <div className="card stack">
        {v.archived && <span className="tag warn" style={{ alignSelf: 'flex-start' }}>Вакансия закрыта</span>}
        <h1 style={{ fontSize: 22 }}>{v.title}</h1>
        <span className="small">{[v.company, v.city].filter(Boolean).join(' · ')}</span>
        {/* ключевая сумма — зелёный сигнал выгоды */}
        <div className={`num ${v.salary ? 'gain' : 'muted'}`} style={{ fontSize: 22 }}>{formatSalary(v.salary)}</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {v.schedule && <span className="tag sec">{(C.schedule as Record<string, string>)[v.schedule]}</span>}
          {v.experience && <span className="tag">{(C.experience as Record<string, string>)[v.experience]}</span>}
        </div>
        <div className="row">
          <button className={`btn sm grow ${decision === 'accept' ? 'btn-sec' : 'btn-ghost'}`} onClick={() => decide('accept')}>{B.accept}</button>
          <button className={`btn sm grow btn-ghost`} style={decision === 'reject' ? { borderColor: 'var(--warn-1)', color: 'var(--warn-1)' } : undefined} onClick={() => decide('reject')}>{B.reject}</button>
        </div>
      </div>

      {v.keySkills.length > 0 && (
        <div className="card stack" style={{ gap: 8 }}>
          <h3>Навыки</h3>
          <div className="row wrap" style={{ gap: 6 }}>{v.keySkills.map((s) => <span key={s} className="tag">{s}</span>)}</div>
        </div>
      )}

      <div className="card stack" style={{ gap: 8 }}>
        <h3>Описание</h3>
        <div className="pre small">{long && !expanded ? desc.slice(0, 600) + '…' : desc}</div>
        {long && <button className="btn btn-ghost sm" onClick={() => setExpanded(!expanded)}>{expanded ? 'Свернуть' : 'Читать полностью'}</button>}
      </div>

      <div className="card stack" style={{ gap: 8 }}>
        <h3>Статус отклика</h3>
        <div className="chips">
          {STATUSES.map(([k, label]) => (
            <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => changeStatus(k)}>{label}</button>
          ))}
        </div>
        <button className="btn btn-ghost sm" onClick={() => openLink(v.url)}>{B.open_on_hh} ↗</button>
      </div>

      <BottomCta
        text={B.generate_letter}
        onClick={() => push({ name: 'letter', vacancyId: id })}
        secondary={{ text: fav ? B.favorite_remove : B.favorite_add, onClick: toggleFav }}
      />
    </div>
  );
}
