export type MemoryKind = 'preference' | 'event' | 'habit';
export type PrivacyLevel = 'private' | 'normal' | 'sensitive';
export type MemoryStatus = 'pending' | 'confirmed' | 'rejected' | 'deleted';

export type StoredMessage = {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
  incomplete?: boolean;
  personaVersion?: string;
};

export type ConversationSummary = {
  id: string;
  updatedAt: number;
  messageCount: number;
  preview: string;
};

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  content: string;
  sourceMessageId: string;
  confidence: number;
  privacy: PrivacyLevel;
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  tags: string[];
  embeddingModel?: string;
};

export type MemoryQuery = {
  text?: string;
  kind?: MemoryKind;
  status?: Exclude<MemoryStatus, 'deleted'>;
  limit?: number;
};

export type ContextFragment = {
  text: string;
  source: string;
  relevance: number;
  privacy: PrivacyLevel;
  createdAt: number;
};
