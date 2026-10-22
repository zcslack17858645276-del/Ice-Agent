import { voiceServer } from './serverVoice.ts';

export type VoiceServiceName = 'whisper' | 'sovits';

export type VoiceServiceStatus = {
  whisper: boolean;
  sovits: boolean;
};

export const voiceAutostartKey = 'ice-agent.voice-autostart.v1';

async function api(path: string, init?: RequestInit): Promise<Response> {
  const server = await voiceServer();
  return fetch(`${server.base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
      ...(init?.headers ?? {})
    }
  });
}

/**
 * Voice services are owned by the standalone Ice Agent server:
 * `/v1/voice/status` probes Whisper (ASR) and GPT-SoVITS (TTS) upstreams,
 * `/v1/voice/start|stop` run the commands configured in `config.json`
 * (`voice.commands.whisperStart` …).
 */
export const VoiceServices = {
  status: async (): Promise<VoiceServiceStatus> => {
    try {
      const response = await api('/v1/voice/status');
      if (!response.ok) return { whisper: false, sovits: false };
      const payload = (await response.json()) as { asr?: boolean; tts?: boolean };
      return { whisper: Boolean(payload.asr), sovits: Boolean(payload.tts) };
    } catch {
      return { whisper: false, sovits: false };
    }
  },
  start: async (service: VoiceServiceName): Promise<void> => {
    await api('/v1/voice/start', { method: 'POST', body: JSON.stringify({ service }) }).catch(() => undefined);
  },
  stop: async (service: VoiceServiceName): Promise<void> => {
    await api('/v1/voice/stop', { method: 'POST', body: JSON.stringify({ service }) }).catch(() => undefined);
  },
  startAll: async (): Promise<void> => {
    await Promise.allSettled([
      api('/v1/voice/start', { method: 'POST', body: JSON.stringify({ service: 'whisper' }) }),
      api('/v1/voice/start', { method: 'POST', body: JSON.stringify({ service: 'sovits' }) })
    ]);
  }
};
