import { useEffect, useRef, useState } from 'react';
import { api, type ActiveSub, type Plan, type Quota } from '../api';
import { B, C, T, errorText, fmt, formatDate } from '../copy';
import { useNav } from '../nav';
import { alert, haptic, openLink } from '../tg';
import { ApiError } from '../api';
import { BottomCta, Countdown, ErrorBox, Skeleton } from '../components/ui';

const METHODS = [['sbp', B.pay_sbp], ['card', B.pay_card], ['crypto', B.pay_crypto]] as const;
const POLL_MS = 4000;
const POLL_MAX_MS = 15 * 60_000; // ссылка Platega живёт ~15 минут

export function Subscription({ limit, paymentId }: { limit?: { resetAt: string; limit: number }; paymentId?: number }) {
  const { refreshMe } = useNav();
  const [data, setData] = useState<{ active: ActiveSub | null; quota: Quota; plans: Plan[] } | null>(null);
  const [plan, setPlan] = useState<Plan['id']>('month');
  const [method, setMethod] = useState<string>('sbp');
  const [pending, setPending] = useState<number | null>(paymentId ?? null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pollStart = useRef(Date.now());

  const load = () => api.subscription().then(setData).catch(setError);
  useEffect(() => { void load(); }, []);

  // опрос статуса платежа, пока пользователь платит во внешнем окне
  useEffect(() => {
    if (!pending) return;
    pollStart.current = Date.now();
    const t = setInterval(async () => {
      if (Date.now() - pollStart.current > POLL_MAX_MS) return clearInterval(t);
      const s = await api.paymentStatus(pending).catch(() => null);
      if (!s || s.status === 'pending') return;
      clearInterval(t);
      setPending(null);
      if (s.status === 'active') { haptic.success(); refreshMe(); void load(); }
      else { haptic.error(); void alert(errorText('PAYMENT_CANCELED')); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [pending]);

  async function pay() {
    setPaying(true);
    try {
      const r = await api.checkout(plan, method);
      setPending(r.subscriptionId);
      openLink(r.paymentUrl);
    } catch (e) {
      haptic.error();
      await alert(errorText(e instanceof ApiError ? e.code : 'PAYMENT_FAILED'));
    } finally {
      setPaying(false);
    }
  }

  async function checkNow() {
    if (!pending) return;
    const s = await api.paymentStatus(pending).catch(() => null);
    if (s?.status === 'active') { setPending(null); haptic.success(); refreshMe(); void load(); }
    else await alert(C.payment_pending_body);
  }

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Skeleton h={100} />;

  const selected = data.plans.find((p) => p.id === plan)!;
  const week = data.plans.find((p) => p.id === 'week');
  const best = [...data.plans].sort((a, b) => a.perDay - b.perDay)[0];
  const limited = Boolean(limit) || (!data.quota.unlimited && data.quota.remaining === 0);

  // ---- ожидание оплаты ----
  if (pending) {
    return (
      <div className="stack">
        <h1>{T.payment_pending}</h1>
        <div className="card accent stack" style={{ alignItems: 'center', textAlign: 'center' }}>
          <div className="progress" style={{ width: '100%' }}><i style={{ width: '100%', animation: 'sk 1.2s infinite' }} /></div>
          <span>{C.payment_pending_body}</span>
        </div>
        <BottomCta text={B.check_payment} onClick={checkNow} />
      </div>
    );
  }

  // ---- PRO активен ----
  if (data.active) {
    const daysLeft = Math.ceil((new Date(data.active.expiresAt).getTime() - Date.now()) / 86400000);
    const total = data.plans.find((p) => p.id === data.active!.plan)?.days ?? 30;
    return (
      <div className="stack">
        <h1>{T.subscription_status}</h1>
        <div className="card accent stack">
          <span className="status" style={{ fontWeight: 700 }}>{fmt(C.pro_active_until, { date: formatDate(data.active.expiresAt) })}</span>
          <div className="row between">
            <span className={daysLeft <= 1 ? 'warn' : ''}>{fmt(C.pro_days_left, { days: daysLeft })}</span>
            <span className="num">{C.quota_unlimited}</span>
          </div>
          <div className={`progress ${daysLeft <= 1 ? 'warn' : ''}`}><i style={{ width: `${Math.min(100, (daysLeft / total) * 100)}%` }} /></div>
        </div>
        <PlanPicker plans={data.plans} plan={plan} setPlan={setPlan} week={week} bestId={best?.id} />
        <MethodPicker method={method} setMethod={setMethod} />
        <BottomCta text={`${B.extend_pro} · ${selected.price} ₽`} onClick={pay} loading={paying} />
      </div>
    );
  }

  // ---- лимит / оформление ----
  return (
    <div className="stack">
      {limited ? (
        <div className="card danger stack" style={{ textAlign: 'center' }}>
          <h2>{T.limit_reached}</h2>
          <span className="small">{C.limit_body}</span>
          <Countdown to={limit?.resetAt ?? data.quota.resetAt} onDone={() => { refreshMe(); void load(); }} />
        </div>
      ) : (
        <h1>{T.subscription}</h1>
      )}

      <div className="formula">{C.limit_formula}</div>

      <PlanPicker plans={data.plans} plan={plan} setPlan={setPlan} week={week} bestId={best?.id} />
      <MethodPicker method={method} setMethod={setMethod} />

      {/* формула расчёта выбранного тарифа */}
      <div className="formula">
        {selected.price} ₽ ÷ {selected.days} дн = <span className="gain">{selected.perDay.toLocaleString('ru-RU')} ₽/день</span>
      </div>

      <BottomCta text={fmt(B.pay, { price: selected.price })} onClick={pay} loading={paying} />
    </div>
  );
}

function PlanPicker({ plans, plan, setPlan, week, bestId }: {
  plans: Plan[]; plan: string; setPlan: (p: Plan['id']) => void; week?: Plan; bestId?: string;
}) {
  return (
    <div className="stack" style={{ gap: 10, marginTop: 6 }}>
      {plans.map((p) => {
        const pct = week && p.id !== 'week' ? Math.round((1 - p.perDay / week.perDay) * 100) : 0;
        return (
          <div key={p.id} className={`card plan row between ${plan === p.id ? 'on' : ''}`} onClick={() => { haptic.select(); setPlan(p.id); }}>
            {p.id === bestId && pct > 0 && <span className="badge">{fmt(C.plan_badge_best, { pct })}</span>}
            <div className="stack" style={{ gap: 2 }}>
              <h3>{p.title}</h3>
              <span className="small">{fmt(C.plan_per_day, { perDay: p.perDay.toLocaleString('ru-RU') })}</span>
            </div>
            <span className={`num ${plan === p.id ? 'gain' : ''}`} style={{ fontSize: 22 }}>{p.price} ₽</span>
          </div>
        );
      })}
    </div>
  );
}

function MethodPicker({ method, setMethod }: { method: string; setMethod: (m: string) => void }) {
  return (
    <div className="chips">
      {METHODS.map(([k, label]) => (
        <button key={k} className={`chip ${method === k ? 'on' : ''}`} onClick={() => { haptic.select(); setMethod(k); }}>{label}</button>
      ))}
    </div>
  );
}
