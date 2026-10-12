import { useEffect, useLayoutEffect, useState } from 'react';
import { api, type SearchParams, type VacancyCard as V } from '../api';
import { B, C, T, fmt } from '../copy';
import { useNav } from '../nav';
import { haptic } from '../tg';
import { VacancyCard } from '../components/VacancyCard';
import { Empty, ErrorBox, QuotaBar, Skeleton } from '../components/ui';

const CITIES = [{ id: '1', text: 'Москва' }, { id: '2', text: 'Санкт-Петербург' }, { id: '113', text: 'Вся Россия' }];

// Состояние живёт вне компонента: «назад» с карточки возвращает ту же выдачу и скролл.
const store = {
  params: { text: '', area: '113' } as SearchParams & { areaName?: string },
  items: [] as V[],
  found: null as number | null,
  page: 0,
  pages: 0,
  scrollY: 0,
};

export function Search() {
  const { push, refreshMe } = useNav();
  const [params, setParams] = useState(store.params);
  const [items, setItems] = useState(store.items);
  const [found, setFound] = useState(store.found);
  const [showFilters, setShowFilters] = useState(false);
  const [cityQuery, setCityQuery] = useState('');
  const [citySuggest, setCitySuggest] = useState<{ id: string; text: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // сохранить скролл в layout-cleanup (до того как App прокрутит новый экран наверх), восстановить — после
  useLayoutEffect(() => () => { store.scrollY = window.scrollY; }, []);
  useEffect(() => { window.scrollTo(0, store.scrollY); }, []);
  useEffect(() => { store.params = params; }, [params]);

  // автодополнение города (hh /suggests/areas), с задержкой
  useEffect(() => {
    if (cityQuery.trim().length < 2) return setCitySuggest([]);
    const t = setTimeout(() => api.areas(cityQuery).then((r) => setCitySuggest(r.items)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [cityQuery]);

  const set = <K extends keyof typeof params>(k: K, v: (typeof params)[K]) => {
    haptic.select();
    setParams((p) => ({ ...p, [k]: v }));
  };

  async function run(page = 0) {
    setLoading(true);
    setError(null);
    try {
      const { areaName: _, ...p } = params;
      const r = await api.search({ ...p, page });
      const next = page ? [...store.items, ...r.items] : r.items;
      Object.assign(store, { items: next, found: r.found, page: r.page, pages: r.pages });
      setItems(next);
      setFound(r.found);
      if (!page) { haptic.success(); setShowFilters(false); refreshMe(); }
    } catch (e) {
      setError(e);
      haptic.error();
    } finally {
      setLoading(false);
    }
  }

  const activeFilters = [params.salary, params.experience, params.schedule].filter(Boolean).length;

  return (
    <div className="stack">
      <div className="card stack">
        <input
          className="input"
          placeholder={C.search_placeholder}
          value={params.text}
          onChange={(e) => setParams((p) => ({ ...p, text: e.target.value }))}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          enterKeyHint="search"
        />
        <div className="chips">
          {CITIES.map((c) => (
            <button key={c.id} className={`chip ${params.area === c.id ? 'on' : ''}`} onClick={() => set('area', c.id)}>{c.text}</button>
          ))}
          {params.areaName && !CITIES.some((c) => c.id === params.area) && <button className="chip on">{params.areaName}</button>}
          <button className={`chip ${activeFilters ? 'on' : ''}`} onClick={() => setShowFilters((s) => !s)}>
            {B.filters}{activeFilters ? ` · ${activeFilters}` : ''}
          </button>
        </div>

        {showFilters && (
          <div className="stack">
            <div>
              <label className="label">{C.city}</label>
              <input className="input" value={cityQuery} onChange={(e) => setCityQuery(e.target.value)} placeholder="Казань" />
              {citySuggest.length > 0 && (
                <div className="chips" style={{ marginTop: 8 }}>
                  {citySuggest.map((c) => (
                    <button key={c.id} className="chip" onClick={() => { setParams((p) => ({ ...p, area: c.id, areaName: c.text })); setCityQuery(''); }}>{c.text}</button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="label">{C.salary_from}</label>
              <input className="input" inputMode="numeric" value={params.salary ?? ''} placeholder="150 000"
                onChange={(e) => set('salary', Number(e.target.value.replace(/\D/g, '')) || undefined)} />
            </div>
            <div>
              <label className="label">Опыт</label>
              <div className="chips">
                {Object.entries(C.experience).map(([k, label]) => (
                  <button key={k} className={`chip ${(params.experience ?? 'any') === k ? 'on' : ''}`}
                    onClick={() => set('experience', k === 'any' ? undefined : k)}>{label}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Формат</label>
              <div className="chips">
                {Object.entries(C.schedule).map(([k, label]) => (
                  <button key={k} className={`chip ${(params.schedule ?? 'any') === k ? 'on' : ''}`}
                    onClick={() => set('schedule', k === 'any' ? undefined : k)}>{label}</button>
                ))}
              </div>
            </div>
            <button className="btn btn-ghost sm" onClick={() => setParams({ text: params.text, area: '113' })}>{B.reset_filters}</button>
          </div>
        )}

        <button className="btn btn-cta block" onClick={() => run()} disabled={loading}>
          {loading && !store.page ? '…' : B.search}
        </button>
        <QuotaBar />
      </div>

      {error ? <ErrorBox error={error} onRetry={() => run()} /> : null}

      {found !== null && <h2>{fmt(T.results, { count: found.toLocaleString('ru-RU') })}</h2>}
      {loading && !items.length && <Skeleton />}
      {found === 0 && <Empty>{C.empty_results}</Empty>}
      {items.map((v) => <VacancyCard key={v.id} v={v} onOpen={() => push({ name: 'vacancy', id: v.id })} />)}

      {items.length > 0 && store.page + 1 < store.pages && (
        <button className="btn btn-sec block" onClick={() => run(store.page + 1)} disabled={loading}>
          {loading ? '…' : B.load_more}
        </button>
      )}
    </div>
  );
}
