import type { ContextFragment, StoredMessage } from './types.ts';
import type { MemoryRepository } from './repository.ts';

export class ContextAssembler {
  constructor(private readonly repository: MemoryRepository) {}
  build(conversationId: string, query: string, budget: number): ContextFragment[] {
    const messages = this.repository.listMessages(conversationId, { tokenBudget: budget });
    const memories = this.repository.listMemories({ text: query, status: 'confirmed', limit: 20 });
    const fragments: ContextFragment[] = [
      ...memories.map((memory) => ({
        text: memory.content,
        source: `memory:${memory.id}/message:${memory.sourceMessageId}`,
        relevance: 1 + memory.confidence,
        privacy: memory.privacy,
        createdAt: memory.createdAt
      })),
      ...messages.map((message) => ({
        text: formatMessage(message),
        source: `message:${message.id}`,
        relevance: message.createdAt / 1e13,
        privacy: 'normal' as const,
        createdAt: message.createdAt
      }))
    ];
    return fragments.sort((a, b) => b.relevance - a.relevance).slice(0, Math.max(1, budget));
  }
}
function formatMessage(message: StoredMessage): string {
  return `${message.role}: ${message.content}`;
}
