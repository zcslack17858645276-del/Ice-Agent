import { invoke } from '@tauri-apps/api/core';

export type VoiceServiceName = 'whisper' | 'sovits';

export type VoiceServiceStatus = {
  whisper: boolean;
  sovits: boolean;
};

export const voiceAutostartKey = 'ice-agent.voice-autostart.v1';

/**
 * Thin wrapper around the WSL service commands. Whisper (ASR) listens on
 * 127.0.0.1:8000 and GPT-SoVITS (TTS) on 127.0.0.1:9880; both are started
 * inside the user's `GPTSoVits` conda environment.
 */
export const VoiceServices = {
  status: () => invoke<VoiceServiceStatus>('voice:services_status'),
  start: (service: VoiceServiceName) => invoke<void>('voice:service_start', { service }),
  stop: (service: VoiceServiceName) => invoke<void>('voice:service_stop', { service }),
  startAll: async (): Promise<void> => {
    await Promise.allSettled([
      invoke('voice:service_start', { service: 'whisper' }),
      invoke('voice:service_start', { service: 'sovits' })
    ]);
  }
};
