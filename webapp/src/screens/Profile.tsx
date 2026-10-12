import { useEffect, useState } from 'react';
import { api, type HistoryItem } from '../api';
import { B, C, T, fmt, formatDate } from '../copy';
import { useNav } from '../nav';
import { Countdown, ErrorBox, Skeleton } from '../components/ui';

const FUNNEL = [['applied', 'Отклики'], ['invited', 'Приглашения'], ['interview', 'Собеседования'], ['offer', 'Офферы']] as const;

export function Profile() {
  const { me, push, refreshMe } = useNav();
  useEffect(refreshMe, []);
  if (!me) return <Skeleton h={100} />;

  const { stats, quota, subscription } = me;
  const funnelMax = Math.max(1, ...FUNNEL.map(([k]) => stats.funnel[k] ?? 0));
  const daysLeft = subscription ? Math.ceil((new Date(subscription.expiresAt).getTime() - Date.now()) / 86400000) : 0;

  return (
    <div className="stack">
      <div className="row between">
        <h1>{me.user.first_name ?? T.profile}</h1>
        <button className="btn btn-ghost sm" onClick={() => push({ name: 'resume' })}>{T.resume}</button>
      </div>

      {/* статистика пути — крупные белые цифры */}
      <div className="stats">
        {([['accepted', C.stats_accepted], ['rejected', C.stats_rejected], ['favorites', C.stats_favorites], ['applied', C.stats_applied]] as const)
          .map(([k, label]) => (
            <div key={k} className="card stat">
              <div className="value">{stats[k]}</div>
              <div className="caption">{label}</div>
            </div>
          ))}
      </div>

      <div className="card stack">
        <h3>Воронка откликов</h3>
        {FUNNEL.map(([k, label]) => (
          <div key={k} className="stack" style={{ gap: 4 }}>
            <div className="row between small"><span>{label}</span><span className="num">{stats.funnel[k] ?? 0}</span></div>
            <div className="progress"><i style={{ width: `${((stats.funnel[k] ?? 0) / funnelMax) * 100}%` }} /></div>
          </div>
        ))}
      </div>

      {/* лимит / подписка: критическое значение — красным */}
      {subscription ? (
        <div className="card accent row between card-click" onClick={() => push({ name: 'subscription' })}>
          <div className="stack" style={{ gap: 2 }}>
            <span className="status" style={{ fontWeight: 700 }}>{fmt(C.pro_active_until, { date: formatDate(subscription.expiresAt) })}</span>
            <span className={`small ${daysLeft <= 1 ? 'warn' : ''}`}>{fmt(C.pro_days_left, { days: daysLeft })}</span>
          </div>
          <span className="small">{B.extend_pro} →</span>
        </div>
      ) : (
        <div className={`card stack ${quota.remaining === 0 ? 'danger' : ''}`}>
          <div className="row between">
            <span>Бесплатные запросы</span>
            <span className={`num ${quota.remaining === 0 ? 'warn' : ''}`} style={{ fontSize: 20 }}>{quota.remaining}/{quota.limit}</span>
          </div>
          <div className={`progress ${quota.remaining === 0 ? 'warn' : ''}`}>
            <i style={{ width: `${(quota.used / quota.limit) * 100}%` }} />
          </div>
          {quota.remaining === 0 && <Countdown to={quota.resetAt} onDone={refreshMe} />}
          <button className="btn btn-cta" onClick={() => push({ name: 'subscription' })}>{B.get_pro}</button>
        </div>
      )}

      <RecentHistory />

      <button className="btn btn-ghost" onClick={() => push({ name: 'support' })}>{B.support}</button>
    </div>
  );
}

export const actionLabel: Record<string, string> = {
  view: 'Просмотр', accept: 'Подходит', reject: 'Не моё', favorite: 'В избранное', unfavorite: 'Из избранного',
  apply: 'Отклик', generate_letter: 'Сгенерирован отклик', status_change: 'Статус', search: 'Поиск',
};
const statusLabel: Record<string, string> = {
  applied: 'отправлен', invited: 'приглашение', interview: 'собеседование', offer: 'оффер', declined: 'отказ',
};

export function HistoryRow({ h }: { h: HistoryItem }) {
  const { push } = useNav();
  const title = h.title ?? (h.action === 'search' ? `«${String(h.meta.text ?? '')}»` : '—');
  return (
    <div className={`row between ${h.vacancy_id ? 'card-click' : ''}`} style={{ padding: '8px 0', gap: 12 }}
      onClick={() => h.vacancy_id && push({ name: 'vacancy', id: h.vacancy_id })}>
      <div className="grow stack" style={{ gap: 0 }}>
        <span className="ellipsis" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="small">
          {actionLabel[h.action] ?? h.action}
          {h.status && <span className={h.status === 'declined' ? 'warn' : 'status'}> · {statusLabel[h.status] ?? h.status}</span>}
        </span>
      </div>
      <span className="small muted">{new Date(h.created_at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</span>
    </div>
  );
}

function RecentHistory() {
  const { push } = useNav();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.history().then((r) => setItems(r.items.slice(0, 5))).catch(setError); }, []);
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="card">
      <div className="row between"><h3>{T.history}</h3>
        <button className="btn btn-ghost sm" onClick={() => push({ name: 'history' })}>Все</button></div>
      {!items ? <Skeleton h={40} n={2} /> : items.length === 0 ? <p className="small">{C.empty_history}</p>
        : items.map((h) => <HistoryRow key={h.id} h={h} />)}
    </div>
  );
}

export function History() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const load = (c?: number) => api.history(c).then((r) => { setItems((x) => [...x, ...r.items]); setCursor(r.nextCursor); }).catch(setError);
  useEffect(() => { void load(); }, []);
  return (
    <div className="stack">
      <h1>{T.history}</h1>
      {error ? <ErrorBox error={error} /> : null}
      <div className="card">
        {cursor === undefined ? <Skeleton h={40} /> : items.length === 0 ? <p className="small">{C.empty_history}</p>
          : items.map((h) => <HistoryRow key={h.id} h={h} />)}
      </div>
      {cursor ? <button className="btn btn-sec" onClick={() => load(cursor)}>{B.load_more}</button> : null}
    </div>
  );
}
