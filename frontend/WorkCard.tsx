import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  workApprove,
  workConfirm,
  workDismiss,
  workRevise,
  workStatus,
  type ApprovalPrompt,
  type WorkCard
} from './workClient';

const STAGE_LABEL: Record<string, string> = {
  confirming: '待确认',
  sending: '发送中',
  working: '执行中',
  completed: '已完成',
  failed: '失败',
  unknown: '待核对',
  dismissed: '已取消'
};

/**
 * Work card: the only confirmation surface. Nothing reaches Codex until the
 * user presses 确认执行, and every approval is answered exactly once.
 */
export function WorkCardView({
  card,
  onChange,
  onClose
}: {
  card: WorkCard;
  onChange: (card: WorkCard) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState(card.stage);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.text);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState(card.last_text ?? '');
  const [approval, setApproval] = useState<ApprovalPrompt | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setStage(card.stage);
    setDraft(card.text);
  }, [card]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ApprovalPrompt>('work:approval', (event) => setApproval(event.payload)).then(
      (off) => {
        unlisten = off;
      }
    );
    return () => {
      unlisten?.();
    };
  }, []);

  // Poll the Rust projection while the engine works; the card only shows the
  // stage badge, never engine logs.
  useEffect(() => {
    if (stage !== 'working' && stage !== 'sending') return;
    const tick = async () => {
      try {
        const detail = (await workStatus(card.id)) as {
          card?: WorkCard;
        } | null;
        const next = detail?.card;
        if (next) {
          setStage(next.stage);
          if (next.last_text) setResult(next.last_text);
          onChange(next);
        }
      } catch {
        /* ignore transient polling errors */
      }
    };
    void tick();
    timer.current = window.setInterval(() => void tick(), 2000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [card.id, stage, onChange]);

  const confirm = async () => {
    setStatus('已提交，等待引擎接单');
    try {
      const response = await workConfirm(card.id, card.version);
      setStage(response.card.stage);
      onChange(response.card);
      setStatus(response.state === 'replayed' ? '这张卡已经执行过' : '已经交给 Codex');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const revise = async () => {
    try {
      const updated = await workRevise(card.id, card.version, draft);
      onChange(updated);
      setEditing(false);
      setStatus('已更新派发内容');
    } catch (error) {
      setStatus(String(error));
    }
  };

  const dismiss = async () => {
    try {
      await workDismiss(card.id, card.version);
      setStage('dismissed');
      setStatus('已取消，没有发送');
      onClose();
    } catch (error) {
      setStatus(String(error));
    }
  };

  const answer = async (decision: 'accept' | 'decline') => {
    if (!approval) return;
    try {
      await workApprove(approval.approvalId, decision);
      setStatus(decision === 'accept' ? '已允许执行' : '已拒绝执行');
      setApproval(null);
    } catch (error) {
      setStatus(String(error));
    }
  };

  const terminal = stage === 'completed' || stage === 'failed' || stage === 'unknown';

  return (
    <section className={`work-card${terminal ? ' terminal' : ''}`} aria-label="Work card">
      <header className="work-card-head">
        <span className="work-card-title">{card.plan.title}</span>
        <span className={`work-stage ${stage}`}>{STAGE_LABEL[stage] ?? stage}</span>
        <button type="button" className="work-close" aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </header>

      <p className="work-goal">{card.text}</p>
      <p className="work-meta">
        目录 {card.cwd} · v{card.version}
      </p>

      {editing ? (
        <div className="work-edit">
          <textarea value={draft} rows={3} onChange={(event) => setDraft(event.target.value)} />
          <div className="work-actions">
            <button type="button" className="work-primary" onClick={() => void revise()}>
              保存修改
            </button>
            <button type="button" className="work-ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="work-actions">
          {!terminal && (
            <>
              <button type="button" className="work-primary" onClick={() => void confirm()}>
                确认执行
              </button>
              <button type="button" className="work-ghost" onClick={() => setEditing(true)}>
                修改
              </button>
              <button type="button" className="work-ghost" onClick={() => void dismiss()}>
                取消
              </button>
            </>
          )}
          {terminal && (
            <button type="button" className="work-ghost" onClick={onClose}>
              关闭卡片
            </button>
          )}
        </div>
      )}

      {approval && (
        <div className="work-approval">
          <p className="work-approval-title">Codex 请求执行命令</p>
          <pre className="work-approval-command">{approval.command ?? approval.reason ?? ''}</pre>
          <div className="work-actions">
            <button type="button" className="work-primary" onClick={() => void answer('accept')}>
              允许
            </button>
            <button type="button" className="work-ghost" onClick={() => void answer('decline')}>
              拒绝
            </button>
          </div>
        </div>
      )}

      {status && <p className="work-status">{status}</p>}
      {result && <p className="work-result">{result}</p>}
    </section>
  );
}
