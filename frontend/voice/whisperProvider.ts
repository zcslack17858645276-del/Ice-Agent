import { invoke } from '@tauri-apps/api/core';
import type { ASRProvider, ASRResult, CapturedAudio, VoiceSettings } from './types.ts';
import { VoiceSessionError } from './types.ts';

type TranscriptionConfig = Pick<VoiceSettings, 'whisperBaseUrl' | 'whisperModel'>;
type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type WhisperResponse = {
  text: string;
  language?: string | null;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
};

export class WhisperASRProvider implements ASRProvider {
  private readonly getConfig: () => TranscriptionConfig;
  private readonly invokeCommand: InvokeCommand;

  constructor(getConfig: () => TranscriptionConfig, invokeCommand: InvokeCommand = invoke) {
    this.getConfig = getConfig;
    this.invokeCommand = invokeCommand;
  }

  async transcribe(audio: CapturedAudio, signal: AbortSignal): Promise<ASRResult> {
    if (signal.aborted) throw cancelledError();
    if (!audio.data.size)
      throw new VoiceSessionError({
        code: 'recognition_failed',
        message: 'No audio was captured.',
        retryable: false
      });

    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const config = this.getConfig();
    const data = Array.from(new Uint8Array(await audio.data.arrayBuffer()));
    if (signal.aborted) throw cancelledError();

    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        void this.invokeCommand('voice:cancel_transcription', { requestId }).catch(() => {});
        reject(cancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });

    try {
      const response = await Promise.race([
        this.invokeCommand<WhisperResponse>('voice:transcribe', {
          request: {
            request_id: requestId,
            base_url: config.whisperBaseUrl,
            model: config.whisperModel,
            content_type: audio.data.type || audio.format,
            data
          }
        }),
        aborted
      ]);
      if (signal.aborted) throw cancelledError();
      if (typeof response?.text !== 'string') throw invalidResponseError();
      return {
        text: response.text,
        language: response.language || 'zh',
        confidence: null,
        segments: Array.isArray(response.segments)
          ? response.segments.map((segment) => ({
              text: segment.text,
              startMs: segment.startMs,
              endMs: segment.endMs
            }))
          : []
      };
    } catch (error) {
      if (error instanceof VoiceSessionError) throw error;
      if (signal.aborted) throw cancelledError();
      throw new VoiceSessionError({
        code: 'network',
        message: 'Unable to reach the local Whisper service. Check that it is running.',
        retryable: true,
        details: error
      });
    } finally {
      removeAbortListener();
    }
  }
}

function cancelledError() {
  return new VoiceSessionError({
    code: 'cancelled',
    message: 'Transcription cancelled.',
    retryable: false
  });
}

function invalidResponseError() {
  return new VoiceSessionError({
    code: 'invalid_response',
    message: 'The Whisper service returned an invalid transcription.',
    retryable: false
  });
}
