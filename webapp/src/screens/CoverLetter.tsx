import { useState } from 'react';
import { api, ApiError } from '../api';
import { B, C, T, errorText } from '../copy';
import { useNav } from '../nav';
import { copyText, haptic, openLink } from '../tg';
import { BottomCta, ErrorBox } from '../components/ui';

const TONES = [['formal', 'Деловой'], ['friendly', 'Дружелюбный'], ['short', 'Коротко']] as const;
type Tone = (typeof TONES)[number][0];

export function CoverLetter({ vacancyId }: { vacancyId: number }) {
  const { me, push, refreshMe } = useNav();
  const [tone, setTone] = useState<Tone>('formal');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [applied, setApplied] = useState(false);

  const q = me?.quota;
  const lowQuota = q && !q.unlimited && (q.remaining ?? 0) <= 1;

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.coverLetter(vacancyId, tone);
      setText(r.text);
      setUrl(r.vacancyUrl);
      setCopied(false);
      haptic.success();
      refreshMe();
    } catch (e) {
      setError(e);
      haptic.error();
    } finally {
      setLoading(false);
    }
  }

  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      haptic.success();
    }
  }

  const needResume = error instanceof ApiError && error.code === 'RESUME_REQUIRED';

  return (
    <div className="stack">
      <h1>{T.cover_letter}</h1>

      <div className="chips">
        {TONES.map(([k, label]) => (
          <button key={k} className={`chip ${tone === k ? 'on' : ''}`} onClick={() => { haptic.select(); setTone(k); }}>{label}</button>
        ))}
      </div>

      {lowQuota && (
        <div className="card danger row between">
          <span className="small warn">
            {q!.remaining === 0 ? errorText('LIMIT_EXCEEDED') : 'Остался 1 бесплатный запрос на сегодня'}
          </span>
          <button className="btn btn-ghost sm" onClick={() => push({ name: 'subscription' })}>{B.get_pro}</button>
        </div>
      )}

      {needResume ? (
        <div className="card stack">
          <span>{C.resume_required}</span>
          <button className="btn btn-sec" onClick={() => push({ name: 'resume' })}>{B.edit_resume}</button>
        </div>
      ) : error ? <ErrorBox error={error} /> : null}

      {text ? (
        <div className="card stack">
          <textarea className="textarea" style={{ minHeight: 320, background: 'transparent', border: 0, padding: 0 }}
            value={text} onChange={(e) => { setText(e.target.value); setCopied(false); }} />
          <div className="divider" />
          <span className="small">{C.letter_hint}</span>
          <div className="row">
            <button className="btn btn-ghost sm grow" onClick={() => openLink(url)}>{B.open_on_hh} ↗</button>
            <button className="btn btn-ghost sm grow" disabled={applied}
              onClick={() => { setApplied(true); haptic.success(); void api.setStatus(vacancyId, 'applied'); }}>
              {applied ? '✓ ' : ''}{B.mark_applied}
            </button>
          </div>
        </div>
      ) : (
        !needResume && (
          <div className="card empty muted small">
            Отклик собирается из вашего резюме и требований вакансии. 1 генерация = 1 запрос.
          </div>
        )
      )}

      {text ? (
        <BottomCta text={copied ? `✓ ${B.copied}` : B.copy} onClick={copy}
          secondary={{ text: loading ? '…' : B.regenerate, onClick: generate }} />
      ) : (
        <BottomCta text={B.generate_letter} onClick={generate} loading={loading} disabled={needResume} />
      )}
    </div>
  );
}
