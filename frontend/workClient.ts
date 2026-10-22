import { invoke } from '@tauri-apps/api/core';

export type WorkCard = {
  id: string;
  version: number;
  state: 'open' | 'claimed' | 'dismissed';
  stage: string;
  command_id: string;
  text: string;
  cwd: string;
  plan: { title: string; steps: string[]; risks: string[] };
  created_at: string;
  approval_id?: string | null;
  native_turn_id?: string | null;
  last_text?: string;
};

export type ApprovalPrompt = {
  approvalId: string;
  requestId: number;
  command?: string;
  reason?: string;
};

export const workPrepare = (text: string, cwd?: string) =>
  invoke<WorkCard>('work:prepare', { text, cwd });

export const workConfirm = (id: string, expectedVersion: number) =>
  invoke<{ card: WorkCard; state: string }>('work:confirm', { id, expectedVersion });

export const workRevise = (id: string, expectedVersion: number, text: string) =>
  invoke<WorkCard>('work:revise', { id, expectedVersion, text });

export const workDismiss = (id: string, expectedVersion: number) =>
  invoke<WorkCard>('work:dismiss', { id, expectedVersion });

export const workStatus = (id: string) => invoke<unknown>('work:status', { id });

export const workApprove = (approvalId: string, decision: 'accept' | 'decline') =>
  invoke<void>('work:approve', { approvalId, decision });

const WORK_HINTS = [
  '帮我',
  '替我',
  '请帮我',
  '实现',
  '修复',
  '重构',
  '添加',
  '新增',
  '删除',
  '迁移',
  '部署',
  '写一个',
  '写个',
  '跑一下',
  '运行',
  '执行',
  '检查一下',
  '排查',
  '优化'
];
const CHAT_HINTS = ['笑话', '故事', '聊', '安慰', '夸', '唱', '讲个', '讲一', '陪', '心情', '晚安'];

/** Work mode runs on this machine, so intent routing is decided locally. */
export function looksLikeWork(text: string): boolean {
  const value = text.trim();
  if (value.length < 4) return false;
  if (CHAT_HINTS.some((hint) => value.includes(hint))) return false;
  return WORK_HINTS.some((hint) => value.includes(hint));
}
