import type { VacancyCard as V } from '../api';
import { B, C, formatSalary } from '../copy';

const scheduleLabel = (s: string | null) => (s ? (C.schedule as Record<string, string>)[s] : undefined);
const expLabel = (e: string | null) => (e ? (C.experience as Record<string, string>)[e] : undefined);

/** Карточка в выдаче: только условия — должность, деньги, город, формат, опыт. */
export function VacancyCard({ v, onOpen }: { v: V; onOpen: () => void }) {
  return (
    <article className="card card-click stack" style={{ gap: 10 }} onClick={onOpen}>
      <div className="stack" style={{ gap: 2 }}>
        <h3>{v.title}</h3>
        <span className="small ellipsis">{[v.company, v.city].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="num" style={{ fontSize: 17 }}>
        {v.salary ? formatSalary(v.salary) : <span className="muted small" style={{ fontFamily: 'var(--font)', fontWeight: 400 }}>{C.salary_none}</span>}
      </div>
      {v.snippet && <p className="small" style={{ margin: 0 }}>{v.snippet}</p>}
      <div className="row between">
        <div className="row wrap" style={{ gap: 6 }}>
          {scheduleLabel(v.schedule) && <span className="tag sec">{scheduleLabel(v.schedule)}</span>}
          {expLabel(v.experience) && <span className="tag">{expLabel(v.experience)}</span>}
        </div>
        <span className="small status" style={{ fontWeight: 600 }}>{B.details} →</span>
      </div>
    </article>
  );
}
