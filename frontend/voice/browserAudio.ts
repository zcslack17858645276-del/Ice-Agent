import type {
  AudioDevice,
  AudioInputProvider,
  AudioPlayer,
  CapturedAudio,
  TTSResult
} from './types.ts';
import { VoiceSessionError } from './types.ts';

export class MediaDevicesInputProvider implements AudioInputProvider {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private listeners = new Set<(level: number) => void>();

  async listDevices(): Promise<AudioDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({
        id: device.deviceId,
        label: device.label || 'Microphone',
        kind: 'input' as const
      }));
  }

  async requestPermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      throw new VoiceSessionError({
        code: 'permission_denied',
        message: 'Microphone permission was denied.',
        retryable: false,
        details: error
      });
    }
  }

  async start(deviceId?: string) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new VoiceSessionError({
        code: 'device_unavailable',
        message: 'Microphone capture is unavailable.',
        retryable: false
      });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true
      });
      this.chunks = [];
      this.startedAt = Date.now();
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };
      this.recorder.start();
    } catch (error) {
      await this.release();
      throw new VoiceSessionError({
        code: 'device_unavailable',
        message: 'Unable to start microphone capture.',
        retryable: true,
        details: error
      });
    }
  }

  async stop(): Promise<CapturedAudio> {
    if (!this.recorder || !this.stream)
      throw new VoiceSessionError({
        code: 'device_unavailable',
        message: 'Microphone is not recording.',
        retryable: false
      });
    const recorder = this.recorder;
    await new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });
    const data = new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' });
    await this.release();
    return {
      data,
      sampleRate: 16000,
      channels: 1,
      format: 'audio/webm',
      durationMs: Date.now() - this.startedAt
    };
  }

  async release() {
    this.recorder = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.chunks = [];
  }

  onLevel(listener: (level: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class WebAudioPlayer implements AudioPlayer {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private volume = 0.8;

  async listDevices(): Promise<AudioDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => ({
        id: device.deviceId,
        label: device.label || 'Speaker',
        kind: 'output' as const
      }));
  }

  async play(
    audio: TTSResult,
    options: { outputDeviceId?: string; volume: number; signal: AbortSignal },
    onLevel?: (level: number) => void
  ) {
    if (!(audio.data instanceof AudioBuffer))
      throw new VoiceSessionError({
        code: 'playback_failed',
        message: 'Audio format is unsupported by Web Audio.',
        retryable: false
      });
    this.context ??= new AudioContext();
    if (options.outputDeviceId && 'setSinkId' in this.context) {
      const sinkContext = this.context as AudioContext & {
        setSinkId: (id: string) => Promise<void>;
      };
      await sinkContext.setSinkId(options.outputDeviceId);
    }
    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, options.volume));
    gain.connect(this.context.destination);
    this.source = this.context.createBufferSource();
    this.source.buffer = audio.data;
    this.source.connect(gain);
    await this.context.resume();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.source?.stop();
        reject(
          new VoiceSessionError({
            code: 'cancelled',
            message: 'Playback cancelled.',
            retryable: false
          })
        );
      };
      if (options.signal.aborted) return abort();
      options.signal.addEventListener('abort', abort, { once: true });
      this.source!.onended = () => {
        options.signal.removeEventListener('abort', abort);
        onLevel?.(0);
        resolve();
      };
      onLevel?.(options.volume);
      this.source!.start();
    });
    this.source = null;
  }

  async stop() {
    this.source?.stop();
    this.source = null;
  }
  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
  }
}
