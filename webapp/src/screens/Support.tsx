import { useState } from 'react';
import { api, ApiError } from '../api';
import { B, C, T, copy, errorText, fmt } from '../copy';
import { alert, haptic } from '../tg';
import { BottomCta } from '../components/ui';

export function Support() {
  const [topic, setTopic] = useState('other');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState<number | null>(null);

  async function send() {
    setSending(true);
    try {
      const { id } = await api.sendTicket(topic, message.trim());
      setSentId(id);
      setMessage('');
      haptic.success();
    } catch (e) {
      haptic.error();
      await alert(errorText(e instanceof ApiError ? e.code : 'INTERNAL'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack">
      <h1>{T.support}</h1>

      {/* FAQ берём из общего copy-файла — без лишнего запроса */}
      <div className="card">
        <h3 style={{ marginBottom: 4 }}>{T.faq}</h3>
        {copy.faq.map((f) => (
          <details key={f.q} className="faq">
            <summary>{f.q}</summary>
            <p className="small">{f.a}</p>
          </details>
        ))}
      </div>

      <div className="card stack">
        <h3>Написать нам</h3>
        <div className="chips">
          {Object.entries(C.support_topic).map(([k, label]) => (
            <button key={k} className={`chip ${topic === k ? 'on' : ''}`} onClick={() => setTopic(k)}>{label}</button>
          ))}
        </div>
        <textarea className="textarea" value={message} maxLength={2000} placeholder={C.support_placeholder}
          onChange={(e) => setMessage(e.target.value)} />
        {sentId && <span className="small gain">{fmt(C.support_sent, { id: sentId })}</span>}
      </div>

      <BottomCta text={B.send_ticket} onClick={send} loading={sending} disabled={message.trim().length < 10} />
    </div>
  );
}
