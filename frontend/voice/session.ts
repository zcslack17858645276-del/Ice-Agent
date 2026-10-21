import type { ConversationService } from '../ai/conversation.ts';
import type {
  AudioInputProvider,
  AudioPlayer,
  ASRProvider,
  TTSProvider,
  VoiceError,
  VoiceEvent,
  VoiceSessionState,
  VoiceSettings
} from './types.ts';
import { VoiceSessionError } from './types.ts';
import type { SpeechQueue } from './speechQueue.ts';

export class VoiceSession {
  private state: VoiceSessionState = 'idle';
  private generation = 0;
  private controller: AbortController | null = null;
  private listeners = new Set<(event: VoiceEvent) => void>();
  private readonly input: AudioInputProvider;
  private readonly asr: ASRProvider;
  private readonly conversation: ConversationService;
  private readonly tts: TTSProvider;
  private readonly player: AudioPlayer;
  private settings: VoiceSettings;
  private readonly conversationId: string;
  private readonly saveCapture?: (audio: import('./types.ts').CapturedAudio) => Promise<string>;
  private readonly speechQueue?: SpeechQueue;

  constructor(
    input: AudioInputProvider,
    asr: ASRProvider,
    conversation: ConversationService,
    tts: TTSProvider,
    player: AudioPlayer,
    settings: VoiceSettings,
    conversationId = 'default',
    saveCapture?: (audio: import('./types.ts').CapturedAudio) => Promise<string>,
    speechQueue?: SpeechQueue
  ) {
    this.input = input;
    this.asr = asr;
    this.conversation = conversation;
    this.tts = tts;
    this.player = player;
    this.settings = settings;
    this.conversationId = conversationId;
    this.saveCapture = saveCapture;
    this.speechQueue = speechQueue;
  }

  getState() {
    return this.state;
  }
  async listDevices() {
    const [inputs, outputs] = await Promise.all([
      this.input.listDevices(),
      this.player.listDevices()
    ]);
    return { inputs, outputs };
  }
  subscribe(listener: (event: VoiceEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  updateSettings(settings: VoiceSettings) {
    this.settings = settings;
    this.player.setVolume(settings.volume);
  }

  async start() {
    if (this.state !== 'idle' && this.state !== 'interrupted' && this.state !== 'error') return;
    await this.cancel('replaced by new recording');
    const generation = ++this.generation;
    this.controller = new AbortController();
    try {
      this.transition('preparing', generation);
      await this.input.requestPermission();
      await this.input.start(this.settings.inputDeviceId || undefined);
      this.transition('recording', generation);
    } catch (error) {
      await this.fail(error, generation);
      await this.input.release();
      this.controller = null;
    }
  }

  async stop() {
    if (this.state !== 'recording') return;
    const generation = this.generation;
    const signal = this.controller?.signal ?? new AbortController().signal;
    try {
      this.transition('stopping', generation);
      const audio = await this.input.stop();
      const capturePath =
        this.settings.retainRecordings && this.saveCapture
          ? await this.saveCapture(audio)
          : undefined;
      if (capturePath)
        this.emit({ state: this.state, previousState: this.state, generation, capturePath });
      this.transition('recognizing', generation);
      const transcript = await this.asr.transcribe(audio, signal);
      this.ensureCurrent(generation, signal);
      if (!transcript.text.trim())
        throw new VoiceSessionError({
          code: 'recognition_failed',
          message: 'No speech was recognized.',
          retryable: false
        });
      this.emit({ state: this.state, previousState: this.state, generation, transcript });
      this.transition('waiting_for_response', generation);
      const assistant = await this.conversation.sendMessage(this.conversationId, transcript.text);
      this.ensureCurrent(generation, signal);
      this.transition('synthesizing', generation);
      if (this.speechQueue) {
        await this.speechQueue.speak(assistant.content, this.settings, signal, (state) =>
          this.transition(state, generation)
        );
        this.ensureCurrent(generation, signal);
        this.transition('idle', generation);
        return;
      }
      const segments = assistant.content.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
      if (!this.settings.autoplay) {
        this.transition('idle', generation);
        return;
      }
      for (const segment of segments.length ? segments : [assistant.content]) {
        this.ensureCurrent(generation, signal);
        const audioResult = await this.tts.synthesize(segment, {}, signal);
        this.transition('playing', generation);
        await this.player.play(
          audioResult,
          {
            outputDeviceId: this.settings.outputDeviceId || undefined,
            volume: this.settings.volume,
            signal
          },
          (level) => this.emit({ state: this.state, previousState: this.state, generation, level })
        );
      }
      this.transition('idle', generation);
    } catch (error) {
      await this.fail(error, generation);
    } finally {
      if (generation === this.generation) {
        await this.input.release();
        this.controller = null;
      }
    }
  }

  async cancel(reason = 'voice session cancelled') {
    if (this.state === 'idle' && !this.controller) {
      await this.speechQueue?.cancel();
      return;
    }
    const generation = this.generation;
    this.generation += 1;
    this.controller?.abort(reason);
    await Promise.allSettled([
      this.input.release(),
      this.player.stop(),
      this.speechQueue?.cancel()
    ]);
    this.controller = null;
    this.emit({ state: 'interrupted', previousState: this.state, generation });
    this.state = 'interrupted';
    this.transition('idle', this.generation);
  }

  private ensureCurrent(generation: number, signal: AbortSignal) {
    if (generation !== this.generation || signal.aborted)
      throw new VoiceSessionError({
        code: 'cancelled',
        message: 'Voice session cancelled.',
        retryable: false
      });
  }

  private transition(next: VoiceSessionState, generation: number) {
    if (generation !== this.generation && next !== 'idle') return;
    const previousState = this.state;
    this.state = next;
    this.emit({ state: next, previousState, generation });
  }

  private emit(event: VoiceEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  private async fail(error: unknown, generation: number) {
    const previousState = this.state;
    const voiceError: VoiceError =
      error instanceof VoiceSessionError
        ? error.voiceError
        : {
            code: 'recognition_failed',
            message: 'Voice interaction failed.',
            retryable: false,
            details: error
          };
    if (generation !== this.generation) return;
    this.state = 'error';
    this.emit({ state: 'error', previousState, generation, error: voiceError });
  }
}
