export type VoiceSessionState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'recognizing'
  | 'waiting_for_response'
  | 'synthesizing'
  | 'playing'
  | 'stopping'
  | 'interrupted'
  | 'error';

export type VoiceErrorCode =
  | 'permission_denied'
  | 'device_unavailable'
  | 'unsupported_format'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'invalid_response'
  | 'recognition_failed'
  | 'synthesis_failed'
  | 'playback_failed';

export type VoiceError = {
  code: VoiceErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
};

export class VoiceSessionError extends Error {
  readonly voiceError: VoiceError;

  constructor(error: VoiceError) {
    super(error.message);
    this.name = 'VoiceSessionError';
    this.voiceError = error;
  }
}

export type AudioDevice = {
  id: string;
  label: string;
  kind: 'input' | 'output';
};

export type CapturedAudio = {
  data: Blob;
  sampleRate: number;
  channels: number;
  format: 'audio/webm' | 'audio/wav' | 'audio/pcm';
  durationMs: number;
};

export type ASRSegment = { text: string; startMs: number; endMs: number };

export type ASRResult = {
  text: string;
  language: string;
  confidence: number | null;
  segments: ASRSegment[];
};

export type TTSOptions = { voiceId?: string; language?: string; rate?: number };

export type TTSResult = {
  data: AudioBuffer | Blob;
  mimeType: string;
  durationMs: number;
  timingMarkers?: readonly { offsetMs: number; text: string }[];
};

export interface AudioInputProvider {
  listDevices(): Promise<AudioDevice[]>;
  requestPermission(): Promise<void>;
  start(deviceId?: string): Promise<void>;
  stop(): Promise<CapturedAudio>;
  release(): Promise<void>;
  onLevel(listener: (level: number) => void): () => void;
}

export interface ASRProvider {
  transcribe(audio: CapturedAudio, signal: AbortSignal): Promise<ASRResult>;
}

export interface TTSProvider {
  synthesize(text: string, options: TTSOptions, signal: AbortSignal): Promise<TTSResult>;
}

export interface AudioPlayer {
  listDevices(): Promise<AudioDevice[]>;
  play(
    audio: TTSResult,
    options: { outputDeviceId?: string; volume: number; signal: AbortSignal },
    onLevel?: (level: number) => void
  ): Promise<void>;
  stop(): Promise<void>;
  setVolume(volume: number): void;
}

export type VoiceEvent = {
  state: VoiceSessionState;
  previousState: VoiceSessionState;
  generation: number;
  transcript?: ASRResult;
  level?: number;
  error?: VoiceError;
  capturePath?: string;
};

export type VoiceSettings = {
  inputDeviceId: string;
  outputDeviceId: string;
  providerId: 'mock' | 'whisper';
  ttsProviderId: 'mock' | 'gpt-sovits';
  whisperBaseUrl: string;
  whisperModel: string;
  gptSovitsBaseUrl: string;
  gptSovitsBatchSize: number;
  referenceAudioPath: string;
  referenceTranscript: string;
  referenceLanguage: string;
  responseLanguage: string;
  volume: number;
  autoplay: boolean;
  retainRecordings: boolean;
};
