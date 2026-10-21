import type {
  ChatMessage,
  Conversation,
  LLMProvider,
  ModelConfig,
  Persona,
  StreamChunk
} from './types.ts';
import { ConversationError } from './types.ts';
import { PersonaService } from './persona.ts';

const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const defaults: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  temperature: 0.7,
  maxOutputTokens: 800,
  contextWindow: 16,
  timeoutMs: 30000,
  retryCount: 2
};

export class ConversationService {
  private readonly provider: LLMProvider;
  private readonly personaService: PersonaService;
  private readonly conversations = new Map<string, Conversation>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(
    provider: LLMProvider,
    personaService = new PersonaService(),
    config: ModelConfig = defaults
  ) {
    this.provider = provider;
    this.personaService = personaService;
    this.config = config;
  }
  setConfig(config: ModelConfig): void {
    this.config = { ...defaults, ...config };
  }
  getPersona(): Persona {
    return this.personaService.getActivePersona();
  }
  setPersona(persona: Persona): void {
    this.personaService.setPersona(persona);
  }
  getConversation(idValue: string): Conversation {
    const existing = this.conversations.get(idValue);
    if (existing) return existing;
    const created = { id: idValue, messages: [], updatedAt: Date.now() };
    this.conversations.set(idValue, created);
    return created;
  }
  restoreConversation(idValue: string, messages: ChatMessage[]): void {
    const conversation = this.getConversation(idValue);
    conversation.messages = messages.map((message) => ({ ...message }));
    conversation.updatedAt = messages.at(-1)?.createdAt ?? Date.now();
  }
  cancel(conversationId: string): void {
    this.controllers.get(conversationId)?.abort();
  }
  async sendMessage(
    conversationId: string,
    content: string,
    onChunk?: (text: string) => void
  ): Promise<ChatMessage> {
    const text = content.trim();
    if (!text)
      throw new ConversationError({
        code: 'empty_content',
        message: 'Please enter a message.',
        retryable: false
      });
    const conversation = this.getConversation(conversationId);
    if (conversation.messages.some((m) => m.role === 'user' && m.content === text && m.incomplete))
      return conversation.messages.find((m) => m.incomplete)!;
    const persona = this.personaService.getActivePersona();
    const systemMessage: ChatMessage = {
      id: id(),
      role: 'system',
      content: this.personaService.systemMessage(),
      createdAt: Date.now(),
      personaVersion: persona.version
    };
    conversation.messages.push(systemMessage);
    conversation.messages.push({ id: id(), role: 'user', content: text, createdAt: Date.now() });
    const history = conversation.messages.filter((message) => message.role !== 'system');
    const trimmed = [systemMessage, ...history.slice(-Math.max(0, this.config.contextWindow - 1))];
    const controller = new AbortController();
    this.controllers.set(conversationId, controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const assistant: ChatMessage = {
      id: id(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      incomplete: true,
      personaVersion: persona.version
    };
    conversation.messages.push(assistant);
    try {
      let attempts = 0;
      while (true) {
        try {
          for await (const chunk of this.provider.stream(
            {
              messages: trimmed
                .filter(Boolean)
                .map(({ role, content: value }) => ({ role, content: value })),
              config: this.config
            },
            controller.signal
          )) {
            this.merge(assistant, chunk, onChunk);
          }
          break;
        } catch (error: unknown) {
          if (timedOut)
            throw new ConversationError({
              code: 'timeout',
              message: 'The AI request timed out. Please try again.',
              retryable: true
            });
          if (
            !(error instanceof ConversationError) ||
            !error.appError.retryable ||
            attempts++ >= this.config.retryCount ||
            controller.signal.aborted
          )
            throw error;
        }
      }
      if (!assistant.content)
        throw new ConversationError({
          code: 'empty_content',
          message: 'The AI service returned an empty response.',
          retryable: false
        });
      assistant.incomplete = false;
      conversation.updatedAt = Date.now();
      return assistant;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(conversationId);
    }
  }
  private merge(message: ChatMessage, chunk: StreamChunk, onChunk?: (text: string) => void) {
    if (chunk.delta) {
      message.content += chunk.delta;
      onChunk?.(chunk.delta);
    }
  }
}
