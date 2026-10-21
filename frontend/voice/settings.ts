import type { VoiceSettings } from './types.ts';

export const voiceSettingsKey = 'ice-agent.voice-settings.v1';

export const defaultVoiceSettings: VoiceSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  providerId: 'whisper',
  ttsProviderId: 'gpt-sovits',
  whisperBaseUrl: 'http://127.0.0.1:8000',
  whisperModel: 'whisper-1',
  gptSovitsBaseUrl: 'http://127.0.0.1:9880',
  gptSovitsBatchSize: 8,
  referenceAudioPath: '',
  referenceTranscript: '',
  referenceLanguage: 'zh',
  responseLanguage: 'zh',
  volume: 0.8,
  autoplay: true,
  retainRecordings: false
};

export function readVoiceSettings(storage: Storage = localStorage): VoiceSettings {
  try {
    const raw: unknown = JSON.parse(storage.getItem(voiceSettingsKey) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return defaultVoiceSettings;
    const value = raw as Record<string, unknown>;
    return {
      inputDeviceId: typeof value.inputDeviceId === 'string' ? value.inputDeviceId : '',
      outputDeviceId: typeof value.outputDeviceId === 'string' ? value.outputDeviceId : '',
      providerId: value.providerId === 'mock' ? 'mock' : 'whisper',
      ttsProviderId: value.ttsProviderId === 'mock' ? 'mock' : 'gpt-sovits',
      whisperBaseUrl:
        typeof value.whisperBaseUrl === 'string'
          ? value.whisperBaseUrl
          : defaultVoiceSettings.whisperBaseUrl,
      whisperModel:
        typeof value.whisperModel === 'string'
          ? value.whisperModel
          : defaultVoiceSettings.whisperModel,
      gptSovitsBaseUrl:
        typeof value.gptSovitsBaseUrl === 'string'
          ? value.gptSovitsBaseUrl
          : defaultVoiceSettings.gptSovitsBaseUrl,
      gptSovitsBatchSize:
        typeof value.gptSovitsBatchSize === 'number'
          ? Math.min(256, Math.max(1, Math.round(value.gptSovitsBatchSize)))
          : defaultVoiceSettings.gptSovitsBatchSize,
      referenceAudioPath:
        typeof value.referenceAudioPath === 'string' ? value.referenceAudioPath : '',
      referenceTranscript:
        typeof value.referenceTranscript === 'string' ? value.referenceTranscript : '',
      referenceLanguage:
        typeof value.referenceLanguage === 'string' ? value.referenceLanguage : 'zh',
      responseLanguage: typeof value.responseLanguage === 'string' ? value.responseLanguage : 'zh',
      volume: typeof value.volume === 'number' ? Math.max(0, Math.min(1, value.volume)) : 0.8,
      autoplay: value.autoplay !== false,
      retainRecordings: value.retainRecordings === true
    };
  } catch {
    return defaultVoiceSettings;
  }
}

export function writeVoiceSettings(settings: VoiceSettings, storage: Storage = localStorage): void {
  storage.setItem(voiceSettingsKey, JSON.stringify(settings));
}
