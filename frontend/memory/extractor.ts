import type { MemoryKind, MemoryRecord, PrivacyLevel, StoredMessage } from './types.ts';
import type { MemoryRepository } from './repository.ts';

export type MemoryCandidate = Omit<MemoryRecord, 'id' | 'updatedAt' | 'status' | 'createdAt'>;
const patterns: Array<{ kind: MemoryKind; regex: RegExp; confidence: number }> = [
  {
    kind: 'preference',
    regex: /\b(?:i|my)\s+(?:prefer|like|love|enjoy)\s+([^.!?]+)/i,
    confidence: 0.82
  },
  {
    kind: 'event',
    regex: /\b(?:today|tomorrow|on\s+\w+day|my\s+birthday)\b[^.!?]*/i,
    confidence: 0.72
  },
  {
    kind: 'habit',
    regex: /\b(?:usually|always|every\s+(?:day|morning|week))\b[^.!?]*/i,
    confidence: 0.7
  }
];
const sensitive = /\b(password|token|api[ _-]?key|credit\s*card|bank|medical|diagnos|ssn)\b/i;

export function extractCandidates(message: StoredMessage): MemoryCandidate[] {
  if (message.role !== 'user' || sensitive.test(message.content)) return [];
  return patterns.flatMap(({ kind, regex, confidence }) => {
    const match = message.content.match(regex);
    if (!match) return [];
    const content = match[0].trim().slice(0, 500);
    return [
      {
        kind,
        content,
        sourceMessageId: message.id,
        confidence,
        privacy: 'normal' as PrivacyLevel,
        tags: [kind]
      }
    ];
  });
}

export function extractAndQueue(
  message: StoredMessage,
  repository: MemoryRepository
): MemoryRecord[] {
  return extractCandidates(message).map((candidate) =>
    repository.createMemory({
      ...candidate,
      id: '',
      createdAt: Date.now(),
      status: candidate.confidence >= 0.8 ? 'pending' : 'pending'
    })
  );
}
