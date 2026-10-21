import type {
  ASRProvider,
  AudioPlayer,
  CapturedAudio,
  TTSOptions,
  TTSProvider,
  TTSResult
} from './types.ts';
import { VoiceSessionError } from './types.ts';

export class MockASRProvider implements ASRProvider {
  async transcribe(audio: CapturedAudio, signal: AbortSignal) {
    if (signal.aborted)
      throw new VoiceSessionError({
        code: 'cancelled',
        message: 'Recognition cancelled.',
        retryable: false
      });
    if (audio.durationMs < 80)
      throw new VoiceSessionError({
        code: 'recognition_failed',
        message: 'No speech was captured.',
        retryable: false
      });
    return {
      text: 'Voice input captured.',
      language: 'en',
      confidence: 1,
      segments: [{ text: 'Voice input captured.', startMs: 0, endMs: audio.durationMs }]
    };
  }
}

export class MockTTSProvider implements TTSProvider {
  async synthesize(text: string, _options: TTSOptions, signal: AbortSignal): Promise<TTSResult> {
    if (signal.aborted)
      throw new VoiceSessionError({
        code: 'cancelled',
        message: 'Synthesis cancelled.',
        retryable: false
      });
    if (typeof AudioContext === 'undefined')
      throw new VoiceSessionError({
        code: 'synthesis_failed',
        message: 'Web Audio is unavailable.',
        retryable: false
      });
    const context = new AudioContext();
    const durationMs = Math.max(180, Math.min(1400, text.length * 18));
    const buffer = context.createBuffer(
      1,
      Math.ceil((context.sampleRate * durationMs) / 1000),
      context.sampleRate
    );
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      const envelope = Math.sin((Math.PI * index) / channel.length);
      channel[index] = Math.sin(index / 8) * envelope * 0.12;
    }
    await context.close();
    return { data: buffer, mimeType: 'audio/wav', durationMs };
  }
}

export class MockAudioPlayer implements AudioPlayer {
  volume = 0.8;
  played: TTSResult[] = [];

  async listDevices() {
    return [];
  }

  async play(
    audio: TTSResult,
    options: { volume: number; signal: AbortSignal },
    onLevel?: (level: number) => void
  ) {
    this.volume = options.volume;
    this.played.push(audio);
    const started = Date.now();
    while (Date.now() - started < audio.durationMs) {
      if (options.signal.aborted)
        throw new VoiceSessionError({
          code: 'cancelled',
          message: 'Playback cancelled.',
          retryable: false
        });
      onLevel?.(this.volume);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30, audio.durationMs)));
    }
    onLevel?.(0);
  }

  async stop() {}
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
  }
}
