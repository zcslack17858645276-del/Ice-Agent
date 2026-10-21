import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PERSONA, validatePersona } from './persona.ts';
import {
  readPersonaSettings,
  resetPersonaSettings,
  writePersonaSettings
} from './personaSettings.ts';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('persona settings default to Trait-derived values and persist validated versions', () => {
  const store = storage();
  assert.equal(readPersonaSettings(store).version, DEFAULT_PERSONA.version);
  const custom = {
    ...DEFAULT_PERSONA,
    name: 'Nova',
    version: 'user-2',
    behaviorRules: ['Be precise.']
  };
  writePersonaSettings(custom, store);
  assert.deepEqual(readPersonaSettings(store), validatePersona(custom));
});

test('persona settings reject empty content and reset to defaults', () => {
  assert.throws(() => validatePersona({ ...DEFAULT_PERSONA, personality: ' ' }));
  const store = storage();
  writePersonaSettings({ ...DEFAULT_PERSONA, name: 'Nova', version: 'user-2' }, store);
  assert.deepEqual(resetPersonaSettings(store), DEFAULT_PERSONA);
});
