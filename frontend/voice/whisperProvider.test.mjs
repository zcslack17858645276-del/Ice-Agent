import assert from 'node:assert/strict';
import test from 'node:test';
import { WhisperASRProvider } from './whisperProvider.ts';
import { VoiceSessionError } from './types.ts';

function capturedAudio(
  blob = new globalThis.Blob(['recording'], { type: 'audio/webm;codecs=opus' })
) {
  return { data: blob, sampleRate: 48000, channels: 1, format: 'audio/webm', durationMs: 500 };
}

test('Whisper provider sends audio configuration and maps the transcript response', async () => {
  let invocation;
  const provider = new WhisperASRProvider(
    () => ({ whisperBaseUrl: 'http://127.0.0.1:8000', whisperModel: 'large-v3' }),
    async (command, args) => {
      invocation = { command, args };
      return {
        text: '你好。',
        language: 'zh',
        segments: [{ text: '你好。', startMs: 0, endMs: 420 }]
      };
    }
  );

  const result = await provider.transcribe(
    capturedAudio(),
    new globalThis.AbortController().signal
  );

  assert.equal(invocation.command, 'voice:transcribe');
  assert.equal(invocation.args.request.base_url, 'http://127.0.0.1:8000');
  assert.equal(invocation.args.request.model, 'large-v3');
  assert.equal(invocation.args.request.content_type, 'audio/webm;codecs=opus');
  assert.equal(invocation.args.request.data.length, 9);
  assert.deepEqual(result, {
    text: '你好。',
    language: 'zh',
    confidence: null,
    segments: [{ text: '你好。', startMs: 0, endMs: 420 }]
  });
});

test('Whisper provider rejects empty recordings and cancels the Rust request', async () => {
  const calls = [];
  const provider = new WhisperASRProvider(
    () => ({ whisperBaseUrl: 'http://127.0.0.1:8000', whisperModel: 'whisper-1' }),
    (command, args) => {
      calls.push({ command, args });
      if (command === 'voice:transcribe') return new Promise(() => {});
      return Promise.resolve();
    }
  );
  await assert.rejects(
    provider.transcribe(
      capturedAudio(new globalThis.Blob([], { type: 'audio/webm' })),
      new globalThis.AbortController().signal
    ),
    (error) => error instanceof VoiceSessionError && error.voiceError.code === 'recognition_failed'
  );

  const controller = new globalThis.AbortController();
  const pending = provider.transcribe(capturedAudio(), controller.signal);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof VoiceSessionError && error.voiceError.code === 'cancelled'
  );
  assert.ok(calls.some((call) => call.command === 'voice:cancel_transcription'));
});
