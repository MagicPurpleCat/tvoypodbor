import { useEffect, useState } from 'react';
import { api } from '../api';
import { C, T, formatDate, formatSalary } from '../copy';
import { useNav } from '../nav';
import { confirm, haptic } from '../tg';
import { Empty, ErrorBox, Skeleton } from '../components/ui';

type Item = Awaited<ReturnType<typeof api.favorites>>['items'][number];

export function Favorites() {
  const { push } = useNav();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => { setError(null); api.favorites().then((r) => setItems(r.items)).catch(setError); };
  useEffect(load, []);

  async function remove(id: number) {
    if (!(await confirm('Убрать вакансию из избранного?'))) return;
    haptic.tap();
    setItems((xs) => xs?.filter((x) => x.id !== id) ?? null);
    api.removeFavorite(id).catch(load);
  }

  return (
    <div className="stack">
      <h1>{T.favorites}{items?.length ? <span className="num muted" style={{ fontSize: 18 }}> {items.length}</span> : null}</h1>
      {error ? <ErrorBox error={error} onRetry={load} /> : null}
      {!items && !error && <Skeleton h={90} />}
      {items?.length === 0 && <Empty>{C.empty_favorites}</Empty>}
      {items?.map((v) => (
        <div key={v.id} className="card tight row" style={{ gap: 12 }}>
          <div className="grow stack card-click" style={{ gap: 4 }} onClick={() => push({ name: 'vacancy', id: v.id })}>
            <h3 className="ellipsis">{v.title}</h3>
            <span className="small ellipsis">{[v.company, v.city].filter(Boolean).join(' · ')}</span>
            <div className="row" style={{ gap: 8 }}>
              <span className="num small">{formatSalary({ from: v.salary_from, to: v.salary_to, currency: v.salary_currency })}</span>
              {v.archived
                ? <span className="tag warn">Закрыта</span>
                : <span className="small muted">с {formatDate(v.added_at)}</span>}
            </div>
          </div>
          <button className="btn btn-ghost sm" aria-label="Убрать" onClick={() => remove(v.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
