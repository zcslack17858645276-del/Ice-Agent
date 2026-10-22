import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WorkCardView } from './WorkCard';
import { workPrepare, type WorkCard } from './workClient';

/**
 * Work mode surface: a dedicated task stream, separate from companion chat.
 * Cards are the unit of work; the newest open card is expanded and older ones
 * collapse into a compact list.
 */
export function WorkPanel() {
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<WorkCard[]>('work:list');
      setCards(list);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const card = await workPrepare(value);
      setText('');
      setCards((current) => [card, ...current]);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  };

  const updateCard = (next: WorkCard) => {
    setCards((current) => current.map((card) => (card.id === next.id ? next : card)));
  };

  const dropCard = (id: string) => {
    setCards((current) => current.filter((card) => card.id !== id));
  };

  const active = cards[0];
  const history = cards.slice(1);

  return (
    <section className="work-surface" aria-label="Work mode">
      <div className="work-composer-row">
        <textarea
          className="work-composer-input"
          rows={2}
          placeholder="描述要完成的工作，例如：统计 workspace 下的文件并生成清单"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void start();
            }
          }}
        />
        <button type="button" className="work-start" onClick={() => void start()} disabled={busy}>
          {busy ? '生成中' : '生成工作卡'}
        </button>
      </div>

      {error && <p className="work-error">{error}</p>}

      <div className="work-stream">
        {!active && <p className="work-empty">还没有工作卡。描述一项任务后先生成卡片，确认后才会执行。</p>}

        {active && (
          <WorkCardView
            key={active.id}
            card={active}
            onChange={updateCard}
            onClose={() => {
              dropCard(active.id);
              void refresh();
            }}
          />
        )}

        {history.length > 0 && (
          <div className="work-history">
            <p className="work-history-title">历史</p>
            {history.map((card) => (
              <button
                key={card.id}
                type="button"
                className="work-history-item"
                onClick={() => {
                  setCards((current) => [card, ...current.filter((item) => item.id !== card.id)]);
                }}
              >
                <span className="work-history-title-text">{card.plan.title || card.text}</span>
                <span className={`work-stage ${card.stage}`}>{card.stage}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
