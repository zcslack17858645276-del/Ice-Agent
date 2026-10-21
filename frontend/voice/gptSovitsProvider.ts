import { invoke } from '@tauri-apps/api/core';
import type { TTSProvider, TTSOptions, TTSResult, VoiceSettings } from './types.ts';
import { VoiceSessionError } from './types.ts';

type TTSConfig = Pick<
  VoiceSettings,
  | 'gptSovitsBaseUrl'
  | 'gptSovitsBatchSize'
  | 'referenceAudioPath'
  | 'referenceTranscript'
  | 'referenceLanguage'
  | 'responseLanguage'
>;
type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class GPTSoVITSTTSProvider implements TTSProvider {
  constructor(
    private readonly getConfig: () => TTSConfig,
    private readonly invokeCommand: InvokeCommand = invoke
  ) {}

  async synthesize(text: string, options: TTSOptions, signal: AbortSignal): Promise<TTSResult> {
    if (signal.aborted) throw cancelledError();
    const content = text.trim();
    const config = this.getConfig();
    if (!content || content.length > 5000)
      throw synthesisError('Speech text must contain 1 to 5000 characters.');
    if (!config.referenceAudioPath.trim() || !config.referenceTranscript.trim()) {
      throw synthesisError('Set a reference audio path and transcript in Voice settings.');
    }
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let removeAbortListener = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        void this.invokeCommand('voice:cancel_synthesis', { requestId }).catch(() => {});
        reject(cancelledError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    });
    try {
      const bytes = await Promise.race([
        this.invokeCommand<number[]>('voice:synthesize', {
          request: {
            request_id: requestId,
            base_url: config.gptSovitsBaseUrl,
            text: content,
            text_lang: options.language || config.responseLanguage,
            ref_audio_path: config.referenceAudioPath,
            prompt_text: config.referenceTranscript,
            prompt_lang: config.referenceLanguage,
            batch_size: config.gptSovitsBatchSize ?? 8
          }
        }),
        aborted
      ]);
      if (signal.aborted) throw cancelledError();
      if (
        !Array.isArray(bytes) ||
        bytes.length < 44 ||
        bytes.length > 50 * 1024 * 1024 ||
        !isWave(bytes)
      ) {
        throw new VoiceSessionError({
          code: 'invalid_response',
          message: 'GPT-SoVITS returned invalid WAV audio.',
          retryable: false
        });
      }
      const buffer = await new AudioContext().decodeAudioData(new Uint8Array(bytes).buffer);
      return { data: buffer, mimeType: 'audio/wav', durationMs: buffer.duration * 1000 };
    } catch (error) {
      if (error instanceof VoiceSessionError) throw error;
      if (signal.aborted) throw cancelledError();
      throw new VoiceSessionError({
        code: 'synthesis_failed',
        message: 'GPT-SoVITS could not synthesize speech. Check that its local service is running.',
        retryable: true,
        details: error
      });
    } finally {
      removeAbortListener();
    }
  }
}

function isWave(bytes: number[]) {
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

function synthesisError(message: string) {
  return new VoiceSessionError({ code: 'synthesis_failed', message, retryable: false });
}

function cancelledError() {
  return new VoiceSessionError({
    code: 'cancelled',
    message: 'Speech synthesis cancelled.',
    retryable: false
  });
}
