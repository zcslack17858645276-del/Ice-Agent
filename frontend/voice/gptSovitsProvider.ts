import type { TTSProvider, TTSOptions, TTSResult, VoiceSettings } from './types.ts';
import { VoiceSessionError } from './types.ts';
import { base64ToBytes, voiceServer } from './serverVoice.ts';

type TTSConfig = Pick<VoiceSettings, 'responseLanguage'>;
type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type SynthesisResponse = { audio?: string; error?: string };

/**
 * Speech synthesis through the standalone Ice Agent server (`POST /v1/tts`).
 * Reference audio and GPT-SoVITS endpoint live on the server.
 */
export class GPTSoVITSTTSProvider implements TTSProvider {
  constructor(
    private readonly getConfig: () => TTSConfig,
    private readonly invokeCommand?: InvokeCommand
  ) {
    void this.invokeCommand;
  }

  async synthesize(text: string, options: TTSOptions, signal: AbortSignal): Promise<TTSResult> {
    if (signal.aborted) throw cancelledError();
    const content = text.trim();
    const config = this.getConfig();
    if (!content || content.length > 5000) {
      throw synthesisError('Speech text must contain 1 to 5000 characters.');
    }

    try {
      const server = await voiceServer();
      if (signal.aborted) throw cancelledError();
      const response = await fetch(`${server.base}/v1/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`
        },
        body: JSON.stringify({
          text: content,
          lang: options.language || config.responseLanguage,
          refAudio: '', // reference audio lives in the server config
          promptLang: '',
          promptText: '',
          batchSize: 8
        }),
        signal
      });
      if (signal.aborted) throw cancelledError();
      if (!response.ok) throw new Error(`server ${response.status}`);
      const payload = (await response.json()) as SynthesisResponse;
      if (!payload.audio) {
        throw new VoiceSessionError({
          code: 'invalid_response',
          message: 'The speech server returned no audio.',
          retryable: false
        });
      }
      const bytes = base64ToBytes(payload.audio);
      if (bytes.length < 44 || !isWave(bytes)) {
        throw new VoiceSessionError({
          code: 'invalid_response',
          message: 'The speech server returned invalid WAV audio.',
          retryable: false
        });
      }
      const buffer = await new AudioContext().decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer);
      return { data: buffer, mimeType: 'audio/wav', durationMs: buffer.duration * 1000 };
    } catch (error) {
      if (error instanceof VoiceSessionError) throw error;
      if (signal.aborted) throw cancelledError();
      throw new VoiceSessionError({
        code: 'synthesis_failed',
        message: 'Unable to reach the Ice Agent server for speech synthesis.',
        retryable: true,
        details: error
      });
    }
  }
}

function isWave(bytes: Uint8Array) {
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
