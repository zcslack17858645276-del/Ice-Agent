export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  incomplete?: boolean;
  personaVersion?: string;
};

export type Conversation = {
  id: string;
  messages: ChatMessage[];
  updatedAt: number;
};

export type ModelConfig = {
  /** Origin only, for example https://api.deepseek.com. */
  baseUrl: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  contextWindow: number;
  timeoutMs: number;
  retryCount: number;
};

export function chatCompletionsEndpoint(config: Pick<ModelConfig, 'baseUrl'>): string {
  const base = config.baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  return `${base}/chat/completions`;
}

export type StreamChunk = { delta: string; done?: boolean; finishReason?: string };

export type AppErrorCode =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'invalid_response'
  | 'empty_content'
  | 'cancelled'
  | 'configuration';

export type AppError = {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export class ConversationError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'ConversationError';
    this.appError = appError;
  }
}

export type Persona = {
  name: string;
  personality: string;
  responseStyle: string;
  behaviorRules: string[];
  version: string;
};

export type ProviderRequest = {
  messages: Array<Pick<ChatMessage, 'role' | 'content'>>;
  config: ModelConfig;
};

export interface LLMProvider {
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
