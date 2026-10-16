import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { AvatarStateMachine } from './stateMachine.ts';

test('temporary state returns to the last stable state', () => {
  const machine = new AvatarStateMachine();
  machine.transition({
    type: 'avatar:set_state',
    state: 'SLEEPING',
    reason: 'explicit-sleep-policy'
  });
  const thinking = machine.transition({ type: 'avatar:set_state', state: 'THINKING' });
  assert.equal(thinking.stableState, 'SLEEPING');
  assert.equal(machine.finishTemporary().state, 'SLEEPING');
});

test('repeated events are suppressed and feedback restores the interrupted loop', () => {
  const machine = new AvatarStateMachine();
  machine.transition({ type: 'avatar:set_state', state: 'WORKING' });
  assert.equal(machine.transition({ type: 'avatar:set_state', state: 'WORKING' }).state, 'WORKING');
  assert.equal(
    machine.transition({ type: 'avatar:set_state', state: 'HAPPY', priority: 2 }).state,
    'HAPPY'
  );
  assert.equal(machine.finishTemporary().state, 'WORKING');
});

test('rejects lower priority and unauthorized sleeping, and falls back unknown states', () => {
  const machine = new AvatarStateMachine();
  machine.transition({ type: 'avatar:set_state', state: 'HAPPY', priority: 3 });
  assert.equal(
    machine.transition({ type: 'avatar:set_state', state: 'SAD', priority: 1 }).state,
    'HAPPY'
  );
  assert.equal(machine.transition({ type: 'avatar:set_state', state: 'SLEEPING' }).state, 'HAPPY');
  const fallbackMachine = new AvatarStateMachine();
  fallbackMachine.transition({ type: 'avatar:set_state', state: 'WORKING' });
  const fallback = fallbackMachine.transition({
    type: 'avatar:set_state',
    state: 'UNKNOWN'
  });
  assert.equal(fallback.state, 'IDLE');
  assert.match(fallback.reason, /fallback to IDLE/);
});

test('expression updates preserve state and invalid expressions are ignored', () => {
  const machine = new AvatarStateMachine();
  machine.transition({ type: 'avatar:set_expression', expression: 'CHEERFUL' });
  assert.equal(machine.getSnapshot().expression, 'CHEERFUL');
  machine.transition({ type: 'avatar:set_expression', expression: 'NOPE' });
  assert.equal(machine.getSnapshot().expression, 'CHEERFUL');
});

test('manifest references present PNG assets and records license status', async () => {
  const manifestUrl = new URL('./manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.version, 1);
  for (const character of manifest.characters) {
    const assetPath = fileURLToPath(new URL(character.asset, manifestUrl));
    const bytes = await readFile(assetPath);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(bytes.readUInt32BE(16), character.resolution);
    assert.equal(bytes.length, character.sizeBytes);
    assert.ok(character.author && character.license && character.source);
    for (const state of ['IDLE', 'THINKING', 'HAPPY', 'SAD', 'WORKING', 'SLEEPING']) {
      assert.ok(character.states[state], `${character.id} is missing ${state}`);
    }
  }
});

test('bundled Live2D model references are complete', async () => {
  const manifestUrl = new URL('./manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const root = new URL('../../', manifestUrl);
  for (const relativePath of manifest.live2d.requiredFiles) {
    const filePath = fileURLToPath(new URL(`assets/live2d/${relativePath}`, root));
    const bytes = await readFile(filePath);
    assert.ok(bytes.length > 0, relativePath);
  }
  const modelPath = fileURLToPath(
    new URL(`assets/live2d/${manifest.live2d.modelPath.split('/').slice(2).join('/')}`, root)
  );
  const model = JSON.parse(await readFile(modelPath, 'utf8'));
  assert.equal(model.FileReferences.Moc, 'seethrough_output_1.moc3');
  assert.equal(model.FileReferences.Textures.length, 1);
  assert.deepEqual(Object.keys(model.FileReferences.Motions).sort(), [
    'Blink',
    'Idle',
    'Nod',
    'Shake'
  ]);
});
