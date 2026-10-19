import type { ConversationSummary, MemoryQuery, MemoryRecord, StoredMessage } from './types.ts';

export type MemoryRepository = {
  saveMessage(message: StoredMessage): void;
  listMessages(
    conversationId: string,
    options?: { before?: number; limit?: number; tokenBudget?: number }
  ): StoredMessage[];
  listConversations(): ConversationSummary[];
  createMemory(
    record: Omit<MemoryRecord, 'updatedAt' | 'status'> & { status?: MemoryRecord['status'] }
  ): MemoryRecord;
  updateMemory(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'confidence' | 'privacy' | 'tags' | 'status'>>
  ): MemoryRecord;
  listMemories(query?: MemoryQuery): MemoryRecord[];
  deleteMemory(id: string, permanent?: boolean): void;
  clearMemories(): void;
  exportData(): string;
};

const now = () => Date.now();
const makeId = (prefix: string) => `${prefix}-${now()}-${Math.random().toString(36).slice(2, 10)}`;
const sensitive =
  /\b(password|passcode|api[ _-]?key|token|secret|credit\s*card|bank\s*account|ssn|medical|diagnos)\b/i;
const validKind = new Set(['preference', 'event', 'habit']);
const validPrivacy = new Set(['private', 'normal', 'sensitive']);

export class InMemoryRepository implements MemoryRepository {
  protected readonly messages = new Map<string, StoredMessage>();
  private readonly memories = new Map<string, MemoryRecord>();

  saveMessage(message: StoredMessage): void {
    if (!message.id || !message.conversationId || !message.content.trim())
      throw new Error('Message fields are required.');
    this.messages.set(message.id, { ...message });
  }
  listMessages(
    conversationId: string,
    options: { before?: number; limit?: number; tokenBudget?: number } = {}
  ): StoredMessage[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const budget = options.tokenBudget ?? Number.MAX_SAFE_INTEGER;
    let used = 0;
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          (!options.before || message.createdAt < options.before)
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .reverse()
      .filter((message) => {
        const tokens = Math.ceil(message.content.length / 4);
        if (used + tokens > budget) return false;
        used += tokens;
        return true;
      })
      .slice(0, limit)
      .reverse();
  }
  listConversations(): ConversationSummary[] {
    const grouped = new Map<string, StoredMessage[]>();
    for (const message of this.messages.values()) {
      if (message.role === 'system') continue;
      const items = grouped.get(message.conversationId) ?? [];
      items.push(message);
      grouped.set(message.conversationId, items);
    }
    return [...grouped.entries()]
      .map(([id, messages]) => {
        const ordered = messages.sort((a, b) => a.createdAt - b.createdAt);
        const latest = ordered.at(-1)!;
        const firstUser = ordered.find((message) => message.role === 'user') ?? latest;
        return {
          id,
          updatedAt: latest.createdAt,
          messageCount: ordered.length,
          preview: firstUser.content.slice(0, 80)
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  createMemory(
    input: Omit<MemoryRecord, 'updatedAt' | 'status'> & { status?: MemoryRecord['status'] }
  ): MemoryRecord {
    if (!validKind.has(input.kind) || !validPrivacy.has(input.privacy))
      throw new Error('Invalid memory kind or privacy.');
    if (!input.content.trim() || !input.sourceMessageId)
      throw new Error('Memory content and source are required.');
    if (sensitive.test(input.content))
      throw new Error('Sensitive content cannot be stored as long-term memory.');
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
      throw new Error('Confidence must be between 0 and 1.');
    const timestamp = now();
    const record: MemoryRecord = {
      ...input,
      id: input.id || makeId('memory'),
      status: input.status ?? 'pending',
      updatedAt: timestamp,
      tags: [...input.tags]
    };
    this.memories.set(record.id, record);
    return { ...record, tags: [...record.tags] };
  }
  updateMemory(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'confidence' | 'privacy' | 'tags' | 'status'>>
  ): MemoryRecord {
    const current = this.memories.get(id);
    if (!current || current.status === 'deleted') throw new Error('Memory was not found.');
    if (patch.content && sensitive.test(patch.content))
      throw new Error('Sensitive content cannot be stored as long-term memory.');
    const next = {
      ...current,
      ...patch,
      updatedAt: now(),
      tags: patch.tags ? [...patch.tags] : [...current.tags]
    };
    if (next.confidence < 0 || next.confidence > 1)
      throw new Error('Confidence must be between 0 and 1.');
    this.memories.set(id, next);
    return { ...next, tags: [...next.tags] };
  }
  listMemories(query: MemoryQuery = {}): MemoryRecord[] {
    const text = query.text?.trim().toLowerCase();
    return [...this.memories.values()]
      .filter(
        (record) =>
          record.status !== 'deleted' &&
          (!query.kind || record.kind === query.kind) &&
          (!query.status || record.status === query.status) &&
          (!text || `${record.content} ${record.tags.join(' ')}`.toLowerCase().includes(text))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(query.limit ?? 100, 500)))
      .map((record) => ({ ...record, tags: [...record.tags] }));
  }
  deleteMemory(id: string, permanent = false): void {
    if (permanent) this.memories.delete(id);
    else if (this.memories.has(id))
      this.memories.set(id, {
        ...this.memories.get(id)!,
        status: 'deleted',
        deletedAt: now(),
        updatedAt: now()
      });
  }
  clearMemories(): void {
    for (const id of this.memories.keys()) this.deleteMemory(id);
  }
  exportData(): string {
    return JSON.stringify({
      version: 1,
      exportedAt: now(),
      memories: this.listMemories(),
      messages: [...this.messages.values()].map((message) => ({ ...message }))
    });
  }
}

export class DurableMemoryRepository extends InMemoryRepository {
  private readonly storage: Storage;
  private readonly key: string;
  constructor(storage: Storage = globalThis.localStorage, key = 'ice-agent.memory.v1') {
    super();
    this.storage = storage;
    this.key = key;
    try {
      const value = JSON.parse(storage.getItem(key) ?? 'null') as {
        memories?: MemoryRecord[];
        messages?: StoredMessage[];
      } | null;
      value?.messages?.forEach((message) => this.saveMessage(message));
      value?.memories?.forEach((memory) => this.createMemory(memory));
    } catch {
      /* Corrupt local data is ignored; native migration remains authoritative. */
    }
  }
  private persist(): void {
    this.storage.setItem(
      this.key,
      JSON.stringify({
        memories: this.listMemories({ limit: 500 }),
        messages: this.listMessagesForExport()
      })
    );
  }
  private listMessagesForExport(): StoredMessage[] {
    return [...this.messages.values()].map((message) => ({ ...message }));
  }
  override saveMessage(message: StoredMessage): void {
    super.saveMessage(message);
    this.persist();
  }
  override createMemory(
    input: Omit<MemoryRecord, 'updatedAt' | 'status'> & { status?: MemoryRecord['status'] }
  ): MemoryRecord {
    const result = super.createMemory(input);
    this.persist();
    return result;
  }
  override updateMemory(
    id: string,
    patch: Partial<Pick<MemoryRecord, 'content' | 'confidence' | 'privacy' | 'tags' | 'status'>>
  ): MemoryRecord {
    const result = super.updateMemory(id, patch);
    this.persist();
    return result;
  }
  override deleteMemory(id: string, permanent = false): void {
    super.deleteMemory(id, permanent);
    this.persist();
  }
  override clearMemories(): void {
    super.clearMemories();
    this.persist();
  }
}
