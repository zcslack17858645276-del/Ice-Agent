import assert from 'node:assert/strict';
import test from 'node:test';
import { MockASRProvider, MockAudioPlayer } from './mockProviders.ts';
import { VoiceSession } from './session.ts';

function inputProvider(durationMs = 200) {
  return {
    async requestPermission() {},
    async start() {},
    async stop() {
      return { data: {}, sampleRate: 16000, channels: 1, format: 'audio/webm', durationMs };
    },
    async release() {},
    async listDevices() {
      return [];
    },
    onLevel() {
      return () => {};
    }
  };
}

function ttsProvider() {
  return {
    async synthesize() {
      return { data: {}, mimeType: 'audio/mock', durationMs: 1 };
    }
  };
}

test('voice session completes capture, transcript, conversation, synthesis, and playback', async () => {
  const player = new MockAudioPlayer();
  const conversation = {
    async sendMessage() {
      return { content: 'response.' };
    }
  };
  const session = new VoiceSession(
    inputProvider(),
    new MockASRProvider(),
    conversation,
    ttsProvider(),
    player,
    {
      inputDeviceId: '',
      outputDeviceId: '',
      providerId: 'mock',
      volume: 0.5,
      autoplay: true,
      retainRecordings: false
    }
  );
  const states = [];
  session.subscribe((event) => states.push(event.state));
  await session.start();
  await session.stop();
  assert.equal(session.getState(), 'idle');
  assert.ok(states.includes('recording'));
  assert.ok(states.includes('recognizing'));
  assert.ok(states.includes('playing'));
  assert.equal(player.played.length, 1);
});

test('cancellation prevents stale playback', async () => {
  let released = 0;
  const input = {
    ...inputProvider(),
    async release() {
      released += 1;
    }
  };
  const player = new MockAudioPlayer();
  const conversation = {
    async sendMessage() {
      return { content: 'response.' };
    }
  };
  const session = new VoiceSession(
    input,
    new MockASRProvider(),
    conversation,
    ttsProvider(),
    player,
    {
      inputDeviceId: '',
      outputDeviceId: '',
      providerId: 'mock',
      volume: 0.5,
      autoplay: true,
      retainRecordings: false
    }
  );
  await session.start();
  await session.cancel();
  assert.equal(session.getState(), 'idle');
  assert.ok(released > 0);
});

test('recordings are saved only when retention is enabled', async () => {
  let saved = 0;
  const createSession = (retainRecordings) =>
    new VoiceSession(
      inputProvider(),
      new MockASRProvider(),
      {
        async sendMessage() {
          return { content: 'response.' };
        }
      },
      ttsProvider(),
      new MockAudioPlayer(),
      {
        inputDeviceId: '',
        outputDeviceId: '',
        providerId: 'mock',
        whisperBaseUrl: 'http://127.0.0.1:8000',
        whisperModel: 'whisper-1',
        volume: 0.5,
        autoplay: false,
        retainRecordings
      },
      'default',
      async () => {
        saved += 1;
        return 'capture.webm';
      }
    );

  const temporarySession = createSession(false);
  await temporarySession.start();
  await temporarySession.stop();
  assert.equal(saved, 0);

  const retainedSession = createSession(true);
  await retainedSession.start();
  await retainedSession.stop();
  assert.equal(saved, 1);
});
