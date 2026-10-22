import type { ASRProvider, ASRResult, CapturedAudio, VoiceSettings } from './types.ts';
import { VoiceSessionError } from './types.ts';
import { blobToBase64, voiceServer } from './serverVoice.ts';

type TranscriptionConfig = unknown;
type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type TranscriptionResponse = {
  text?: string;
  error?: string;
};

/**
 * Speech recognition through the standalone Ice Agent server (`POST /v1/asr`).
 * The server owns the Whisper endpoint, clients only send audio.
 */
export class WhisperASRProvider implements ASRProvider {
  private readonly getConfig: () => TranscriptionConfig;
  private readonly invokeCommand: InvokeCommand;

  constructor(getConfig: () => TranscriptionConfig, invokeCommand?: InvokeCommand) {
    this.getConfig = getConfig;
    this.invokeCommand = invokeCommand ?? (async () => undefined as never);
    void this.invokeCommand;
  }

  async transcribe(audio: CapturedAudio, signal: AbortSignal): Promise<ASRResult> {
    if (signal.aborted) throw cancelledError();
    if (!audio.data.size) {
      throw new VoiceSessionError({
        code: 'recognition_failed',
        message: 'No audio was captured.',
        retryable: false
      });
    }

    try {
      const [server, base64] = await Promise.all([voiceServer(), blobToBase64(audio.data)]);
      if (signal.aborted) throw cancelledError();
      const response = await fetch(`${server.base}/v1/asr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`
        },
        body: JSON.stringify({ audio: base64, mime: audio.data.type || audio.format }),
        signal
      });
      if (signal.aborted) throw cancelledError();
      if (!response.ok) throw new Error(`server ${response.status}`);
      const payload = (await response.json()) as TranscriptionResponse;
      if (signal.aborted) throw cancelledError();
      if (typeof payload.text !== 'string') throw invalidResponseError();
      return { text: payload.text, language: 'zh', confidence: null, segments: [] };
    } catch (error) {
      if (error instanceof VoiceSessionError) throw error;
      if (signal.aborted) throw cancelledError();
      throw new VoiceSessionError({
        code: 'network',
        message: 'Unable to reach the Ice Agent server for speech recognition.',
        retryable: true,
        details: error
      });
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
    message: 'The speech server returned an invalid transcription.',
    retryable: false
  });
}
