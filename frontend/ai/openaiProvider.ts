import { chatCompletionsEndpoint, type LLMProvider, type ProviderRequest, type StreamChunk } from './types.ts';
import { ConversationError as AppConversationError } from './types.ts';
import { invoke } from '@tauri-apps/api/core';

export type ApiKeySource = { getApiKey(): Promise<string | null> };
export type RequestTransport = (request: { endpoint: string; apiKey: string; body: string; signal?: AbortSignal }) => Promise<Response>;

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly keys: ApiKeySource, private readonly fetcher: typeof fetch = fetch) {}
  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const key = await this.keys.getApiKey();
    if (!key) throw new AppConversationError({ code: 'configuration', message: 'Configure an API key in Chat Configuration before sending a message.', retryable: false });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    let response: Response;
    try {
      response = await this.fetcher(chatCompletionsEndpoint(request.config), { method: 'POST', headers, signal, body: JSON.stringify({ model: request.config.model, messages: request.messages, temperature: request.config.temperature, max_tokens: request.config.maxOutputTokens, stream: true }) });
    } catch (error: unknown) {
      if (signal?.aborted) throw new AppConversationError({ code: 'cancelled', message: 'Request cancelled.', retryable: false });
      throw new AppConversationError({ code: 'network', message: 'Unable to reach the AI service.', retryable: true, details: error });
    }
    if (response.status === 429) throw new AppConversationError({ code: 'rate_limit', message: 'The AI service is busy. Please try again shortly.', retryable: true });
    if (!response.ok) throw new AppConversationError({ code: 'network', message: 'The AI service returned an error.', retryable: response.status >= 500 });
    if (!response.body) throw new AppConversationError({ code: 'invalid_response', message: 'The AI service returned no stream.', retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const read = await reader.read();
      buffer += decoder.decode(read.value ?? new Uint8Array(), { stream: !read.done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { yield { delta: '', done: true }; return; }
        try {
          const data: unknown = JSON.parse(payload);
          const choice = (data as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string }> }).choices?.[0];
          const delta = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
          if (delta || choice?.finish_reason) yield { delta, done: Boolean(choice?.finish_reason), finishReason: choice?.finish_reason };
        } catch { throw new AppConversationError({ code: 'invalid_response', message: 'The AI service returned malformed data.', retryable: false }); }
      }
      if (read.done) break;
    }
  }
}

type BackendChunk = { delta: string; done?: boolean; finishReason?: string };
/** Production transport: the Rust command owns credential retrieval and HTTPS. */
export class TauriOpenAIProvider implements LLMProvider {
  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    if (signal?.aborted) throw new AppConversationError({ code: 'cancelled', message: 'Request cancelled.', retryable: false });
    try {
      const chunks = await invoke<BackendChunk[]>('ai:stream', { request: { base_url: request.config.baseUrl, model: request.config.model, temperature: request.config.temperature, max_output_tokens: request.config.maxOutputTokens, messages: request.messages } });
      for (const chunk of chunks) { if (signal?.aborted) throw new AppConversationError({ code: 'cancelled', message: 'Request cancelled.', retryable: false }); yield chunk; }
    } catch (error: unknown) {
      if (error instanceof AppConversationError) throw error;
      throw new AppConversationError({ code: 'network', message: 'Unable to reach the AI service.', retryable: true, details: error });
    }
  }
}

