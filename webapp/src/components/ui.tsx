import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tg, inTelegram, COLORS } from '../tg';
import { B, C, T, fmt, errorText } from '../copy';
import { ApiError } from '../api';
import { useNav } from '../nav';

/** Монограмма «ТП» — та же геометрия, что в assets/src/logo.svg. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00FF9D" />
          <stop offset="1" stopColor="#00D46B" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#logo-g)" />
      <g fill="#07080B">
        <rect x="13" y="24" width="33" height="11" rx="2" />
        <rect x="24" y="24" width="11" height="52" rx="2" />
        <path d="M52 26a2 2 0 0 1 2-2h31a2 2 0 0 1 2 2v48a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V35H63v39a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2Z" />
      </g>
    </svg>
  );
}

/** Шапка: логотип слева, баланс запросов и аватар справа (тап → подписка). */
export function Header() {
  const { me, push } = useNav();
  const q = me?.quota;
  const photo = tg?.initDataUnsafe.user?.photo_url;
  const initial = (me?.user.first_name ?? 'U').slice(0, 1);
  return (
    <header className="header">
      <div className="logo"><LogoMark />ТвойПодбор</div>
      <button className="balance" onClick={() => push({ name: 'subscription' })} aria-label={T.subscription}>
        {q && (q.unlimited
          ? <span className="small gain" style={{ fontWeight: 700 }}>PRO</span>
          : <span className="small">
              <span className={`num ${q.remaining === 0 ? 'warn' : ''}`}>{q.remaining}</span>
              <span className="muted">/{q.limit}</span>
            </span>)}
        {photo ? <img className="avatar" src={photo} alt="" /> : <span className="avatar">{initial}</span>}
      </button>
    </header>
  );
}

const icons = {
  search: <path d="M11 4a7 7 0 1 0 4.2 12.6l3.6 3.6 1.4-1.4-3.6-3.6A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" fill="currentColor" />,
  favorites: <path d="M12 20.5 4.6 13a4.9 4.9 0 0 1 7-6.9l.4.4.4-.4a4.9 4.9 0 0 1 7 6.9Z" fill="none" stroke="currentColor" strokeWidth="2" />,
  profile: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5" fill="none" stroke="currentColor" strokeWidth="2" />,
};

export function TabBar() {
  const { route, tab } = useNav();
  const items = [['search', T.search], ['favorites', T.favorites], ['profile', T.profile]] as const;
  return (
    <nav className="tabbar">
      <div className="tabbar-inner">
        {items.map(([name, label]) => (
          <button key={name} className={`tab ${route.name === name ? 'on' : ''}`} onClick={() => tab(name)}>
            <svg viewBox="0 0 24 24">{icons[name]}</svg>
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

interface CtaProps {
  text: string;
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
  secondary?: { text: string; onClick: () => void };
}

/**
 * Главная кнопка экрана. В Telegram — нативные MainButton (зелёный, с shine) и SecondaryButton (фиолетовый),
 * вне Telegram — их HTML-аналог внизу экрана.
 */
export function BottomCta({ text, onClick, loading, disabled, secondary }: CtaProps) {
  const cb = useRef(onClick);
  const cb2 = useRef(secondary?.onClick);
  cb.current = onClick;
  cb2.current = secondary?.onClick;

  useEffect(() => {
    if (!tg) return;
    const h = () => cb.current();
    tg.MainButton.onClick(h);
    return () => { tg!.MainButton.offClick(h); tg!.MainButton.hide(); };
  }, []);

  useEffect(() => {
    if (!tg) return;
    tg.MainButton.setParams({
      text, color: COLORS.cta, text_color: COLORS.ctaText, is_visible: true,
      is_active: !disabled && !loading, has_shine_effect: !disabled,
    });
    loading ? tg.MainButton.showProgress(false) : tg.MainButton.hideProgress();
  }, [text, loading, disabled]);

  const sb = tg?.SecondaryButton;
  useEffect(() => {
    if (!sb || !secondary) return;
    const h = () => cb2.current?.();
    sb.onClick(h);
    sb.setParams({ text: secondary.text, color: COLORS.secondary, text_color: COLORS.white, is_visible: true, position: 'left' });
    return () => { sb.offClick(h); sb.hide(); };
  }, [sb, secondary?.text]);

  if (inTelegram && (!secondary || sb)) return null;
  return (
    <div className="bottom-cta">
      {secondary && <button className="btn btn-sec" style={{ flex: '0 1 auto' }} onClick={secondary.onClick}>{secondary.text}</button>}
      <button className="btn btn-cta grow" onClick={onClick} disabled={disabled || loading}>
        {loading ? '…' : text}
      </button>
    </div>
  );
}

/** Обратный отсчёт до секунды. Красный — это всегда срочность (лимит/дедлайн). */
export function Countdown({ to, onDone }: { to: string; onDone?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, new Date(to).getTime() - now);
  useEffect(() => { if (left === 0) onDone?.(); }, [left === 0]);
  const s = Math.floor(left / 1000);
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0'));
  const labels = ['час', 'мин', 'сек'];
  return (
    <div className="timer" role="timer" aria-label={parts.join(':')}>
      {parts.map((p, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          {i > 0 && <span className="sep">:</span>}
          <div className="cell"><b>{p}</b><span>{labels[i]}</span></div>
        </div>
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const code = error instanceof ApiError ? error.code : 'INTERNAL';
  if (code === 'LIMIT_EXCEEDED') return null; // App уже открыл экран подписки
  return (
    <div className="card danger stack">
      <span className="warn">{errorText(code)}</span>
      {onRetry && <button className="btn btn-ghost sm" onClick={onRetry}>{B.retry}</button>}
    </div>
  );
}

export function Skeleton({ h = 120, n = 3 }: { h?: number; n?: number }) {
  return <div className="stack">{Array.from({ length: n }, (_, i) => <div key={i} className="skeleton" style={{ height: h }} />)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="card empty muted">{children}</div>;
}

export function QuotaBar() {
  const { me } = useNav();
  const q = me?.quota;
  if (!q || q.unlimited) return q ? <div className="small gain">{C.quota_unlimited}</div> : null;
  const pct = ((q.limit - (q.remaining ?? 0)) / q.limit) * 100;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row between small">
        <span>{fmt(C.quota_left, { remaining: q.remaining ?? 0, limit: q.limit })}</span>
      </div>
      <div className={`progress ${q.remaining === 0 ? 'warn' : ''}`}><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
