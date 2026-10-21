import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultVoiceSettings,
  readVoiceSettings,
  voiceSettingsKey,
  writeVoiceSettings
} from './settings.ts';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

test('voice settings default to local Whisper without retaining recordings', () => {
  assert.equal(defaultVoiceSettings.providerId, 'whisper');
  assert.equal(defaultVoiceSettings.whisperBaseUrl, 'http://127.0.0.1:8000');
  assert.equal(defaultVoiceSettings.retainRecordings, false);
});

test('voice settings persist and restore Whisper configuration', () => {
  const storage = memoryStorage();
  const settings = {
    ...defaultVoiceSettings,
    providerId: 'whisper',
    whisperBaseUrl: 'http://localhost:9000',
    whisperModel: 'large-v3'
  };
  writeVoiceSettings(settings, storage);
  assert.deepEqual(readVoiceSettings(storage), settings);
  assert.ok(storage.getItem(voiceSettingsKey));
});

test('older settings retain valid defaults for new Whisper fields', () => {
  const storage = memoryStorage({
    [voiceSettingsKey]: JSON.stringify({ providerId: 'mock', volume: 0.4 })
  });
  const settings = readVoiceSettings(storage);
  assert.equal(settings.providerId, 'mock');
  assert.equal(settings.whisperBaseUrl, defaultVoiceSettings.whisperBaseUrl);
  assert.equal(settings.whisperModel, defaultVoiceSettings.whisperModel);
  assert.equal(settings.retainRecordings, false);
});
