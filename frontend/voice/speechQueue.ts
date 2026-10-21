import type { AudioPlayer, TTSProvider, TTSResult, VoiceSettings } from './types.ts';
import { VoiceSessionError } from './types.ts';

type SpeechState = 'synthesizing' | 'playing';

/**
 * Sentence-level speech pipeline.
 *
 * Segments can be pushed while the assistant is still streaming, and the next
 * segment is synthesized while the current one plays, so there is no silent
 * gap between sentences (GPT-SoVITS takes ~1-2s per request).
 */
export class SpeechQueue {
  private generation = 0;
  private controller: AbortController | null = null;
  private settings: VoiceSettings | null = null;
  private onState?: (state: SpeechState) => void;
  private pending: string[] = [];
  private prefetch: { text: string; audio: Promise<TTSResult> } | null = null;
  private pumping = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly tts: TTSProvider,
    private readonly player: AudioPlayer
  ) {}

  /** Starts a new utterance; anything still playing is dropped. */
  begin(settings: VoiceSettings, signal?: AbortSignal, onState?: (state: SpeechState) => void) {
    this.generation += 1;
    this.controller?.abort('speech replaced');
    void this.player.stop();
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    this.controller = controller;
    this.settings = settings;
    this.onState = onState;
    this.pending = [];
    this.prefetch = null;
    this.pumping = false;
    this.idle = Promise.resolve();
  }

  /** Queues text; complete sentences start synthesizing immediately. */
  push(text: string) {
    if (!this.settings || this.controller?.signal.aborted) return;
    for (const segment of splitSentences(text)) {
      const trimmed = segment.trim();
      if (trimmed) this.pending.push(trimmed);
    }
    void this.pump();
  }

  /** Resolves once every queued segment has finished playing. */
  async finish(): Promise<void> {
    while (this.pumping || this.pending.length) {
      await this.pump();
    }
  }

  /** Convenience wrapper for a complete reply. */
  async speak(
    text: string,
    settings: VoiceSettings,
    signal?: AbortSignal,
    onState?: (state: SpeechState) => void
  ) {
    await this.cancel();
    if (!settings.autoplay || !text.trim()) return;
    this.begin(settings, signal, onState);
    this.push(text);
    await this.finish();
  }

  async cancel() {
    this.generation += 1;
    this.controller?.abort('speech replaced');
    this.controller = null;
    this.settings = null;
    this.pending = [];
    this.prefetch = null;
    this.pumping = false;
    await this.player.stop();
  }

  private pump(): Promise<void> {
    if (this.pumping) return this.idle;
    this.pumping = true;
    let resolveIdle = () => {};
    this.idle = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });
    const generation = this.generation;
    const signal = this.controller?.signal;

    const run = async () => {
      try {
        while (this.pending.length && generation === this.generation && signal && !signal.aborted) {
          const text = this.pending[0];
          const job =
            this.prefetch?.text === text ? this.prefetch.audio : this.synthesize(text, signal);
          this.prefetch = null;
          this.onState?.('synthesizing');
          const audio = await job;
          if (generation !== this.generation) break;
          this.pending.shift();
          // Warm the next sentence while the current one is playing.
          if (this.pending.length) {
            this.prefetch = {
              text: this.pending[0],
              audio: this.synthesize(this.pending[0], signal)
            };
          }
          this.onState?.('playing');
          await this.player.play(audio, {
            outputDeviceId: this.settings?.outputDeviceId || undefined,
            volume: this.settings?.volume ?? 0.8,
            signal
          });
        }
      } catch (error) {
        if (!isCancelled(error)) {
          console.warn('[speech:pipeline]', error);
        }
      } finally {
        if (generation === this.generation) this.pumping = false;
        resolveIdle();
      }
    };

    void run();
    return this.idle;
  }

  private synthesize(text: string, signal: AbortSignal): Promise<TTSResult> {
    const job = this.tts.synthesize(text, { language: this.settings?.responseLanguage }, signal);
    // Keep an unawaited prefetch from surfacing as an unhandled rejection.
    job.catch(() => undefined);
    return job;
  }
}

export function splitSentences(text: string): string[] {
  const parts =
    text
      .match(/[^.!?。！？]+[.!?。！？]*/gu)
      ?.map((part) => part.trim())
      .filter(Boolean) ?? [];
  return parts.length ? parts : [text.trim()];
}

/**
 * Returns the length of the leading complete sentences in `text`, so callers
 * can speak a streamed answer before it is fully received.
 */
export function completeSentenceLength(text: string): number {
  const matches = [...text.matchAll(/[^.!?。！？]+[.!?。！？]+/gu)];
  const last = matches.at(-1);
  return last ? (last.index ?? 0) + last[0].length : 0;
}

function isCancelled(error: unknown) {
  return error instanceof VoiceSessionError && error.appError.code === 'cancelled';
}
