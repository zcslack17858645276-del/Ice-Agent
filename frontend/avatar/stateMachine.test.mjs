import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { AvatarStateMachine } from './stateMachine.ts';
import { discoverLive2DModels } from './live2d/catalogCore.mjs';
import { getMotionGroup, resolveModelResource } from './live2d/model.ts';
import { loadLive2DResources, validateLive2DModel } from './live2d/runtime.ts';

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

test('model discovery includes only model entries in designated asset directories', () => {
  const files = [
    'xglk/renamed.model3.json',
    'miku_free/runtime/miku.model3.json',
    'miku_pro/runtime/miku_sample_t04.model3.json',
    'xglk/runtime/shaders/config.json',
    'other/model.model3.json',
    'xglk/not-a-model.json'
  ];
  assert.deepEqual(discoverLive2DModels(files), [
    'miku_free/runtime/miku.model3.json',
    'miku_pro/runtime/miku_sample_t04.model3.json',
    'xglk/renamed.model3.json'
  ]);
});

test('Live2D model entries and every configured resource are present', async () => {
  const root = new URL('../../assets/', import.meta.url);
  const modelFiles = [
    'xglk/seethrough_output_1.model3.json',
    'miku_free/runtime/miku.model3.json',
    'miku_pro/runtime/miku_sample_t04.model3.json'
  ];
  for (const modelFile of modelFiles) {
    const modelUrl = new URL(modelFile, root);
    const fetcher = async (url) => {
      try {
        const bytes = await readFile(fileURLToPath(url));
        return new globalThis.Response(bytes, { status: 200 });
      } catch {
        return new globalThis.Response(null, { status: 404 });
      }
    };
    await validateLive2DModel(modelUrl.href, fetcher);
    const resources = await loadLive2DResources(modelUrl.href, fetcher);
    assert.ok(resources.moc.byteLength > 0);
    assert.ok(resources.texturePaths.length > 0);
  }
  const xglkUrl = new URL(modelFiles[0], root);
  const xglkFetcher = async (url) =>
    new globalThis.Response(await readFile(fileURLToPath(url)), { status: 200 });
  const resources = await loadLive2DResources(xglkUrl.href, xglkFetcher);
  assert.ok(resources.physics);
  assert.deepEqual(Object.keys(resources.motions).sort(), ['Blink', 'Idle', 'Nod', 'Shake']);
  assert.equal(getMotionGroup('IDLE'), 'Idle');
  assert.equal(getMotionGroup('THINKING'), 'Nod');
  assert.equal(getMotionGroup('HAPPY'), 'Shake');
});

test('all six pet states resolve to supported motion groups or the idle fallback', () => {
  const expected = {
    IDLE: 'Idle',
    THINKING: 'Nod',
    HAPPY: 'Shake',
    SAD: 'Shake',
    WORKING: 'Idle',
    SLEEPING: 'Idle'
  };
  for (const [state, group] of Object.entries(expected)) {
    assert.equal(getMotionGroup(state), group);
  }
});

test('renamed entry resolves resources against its configured model directory', async () => {
  const entryUrl = 'https://models.test/xglk/renamed.model3.json';
  const originalResourceBase = 'https://models.test/xglk/seethrough_output_1.model3.json';
  const model = JSON.parse(
    await readFile(
      new URL('../../assets/xglk/seethrough_output_1.model3.json', import.meta.url),
      'utf8'
    )
  );
  const requested = [];
  const fetcher = async (url) => {
    requested.push(url);
    const relative = new URL(url).pathname.replace('/xglk/', '');
    if (relative === 'renamed.model3.json') {
      return new globalThis.Response(JSON.stringify(model), { status: 200 });
    }
    const bytes = await readFile(
      fileURLToPath(new URL(`../../assets/xglk/${relative}`, import.meta.url))
    );
    return new globalThis.Response(bytes, { status: 200 });
  };
  const resources = await loadLive2DResources(entryUrl, fetcher, originalResourceBase);
  assert.equal(resources.modelPath, entryUrl);
  assert.ok(requested.includes('https://models.test/xglk/seethrough_output_1.moc3'));
  assert.equal(
    resolveModelResource(originalResourceBase, model.FileReferences.Textures[0]),
    'https://models.test/xglk/seethrough_output_1.4096/texture_00.png'
  );
});

test('required model resources fail clearly while optional sections may be absent', async () => {
  const modelUrl = 'https://models.test/models/renamed.model3.json';
  const model = {
    FileReferences: { Moc: 'body.moc3', Textures: ['textures/body.png'] }
  };
  const resources = new Map([
    [modelUrl, JSON.stringify(model)],
    ['https://models.test/models/body.moc3', new Uint8Array([1])],
    ['https://models.test/models/textures/body.png', new Uint8Array([2])]
  ]);
  const fetcher = async (url) => {
    const value = resources.get(url);
    return value === undefined
      ? new globalThis.Response(null, { status: 404 })
      : new globalThis.Response(value, { status: 200 });
  };
  await validateLive2DModel(modelUrl, fetcher);
  const loaded = await loadLive2DResources(modelUrl, fetcher);
  assert.equal(loaded.physics, null);
  assert.deepEqual(loaded.motions, {});
  assert.deepEqual(loaded.expressions, {});

  resources.delete('https://models.test/models/body.moc3');
  await assert.rejects(validateLive2DModel(modelUrl, fetcher), /required resource.*body\.moc3/);
  await assert.rejects(loadLive2DResources(modelUrl, fetcher), /failed to load.*body\.moc3/);
});

test('configured physics, motions, and expressions resolve relatively and missing files fail', async () => {
  const modelUrl = 'https://models.test/pack/renamed.model3.json';
  const model = {
    FileReferences: {
      Moc: 'model.moc3',
      Textures: ['tex.png'],
      Physics: 'settings/physics.json',
      Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] },
      Expressions: [{ Name: 'Happy', File: 'expressions/happy.exp3.json' }]
    }
  };
  const data = new Map([
    [modelUrl, JSON.stringify(model)],
    ['https://models.test/pack/model.moc3', new Uint8Array([1])],
    ['https://models.test/pack/tex.png', new Uint8Array([2])],
    ['https://models.test/pack/settings/physics.json', JSON.stringify({ Version: 3 })],
    ['https://models.test/pack/motions/idle.motion3.json', JSON.stringify({ Meta: {} })],
    ['https://models.test/pack/expressions/happy.exp3.json', JSON.stringify({ Parameters: [] })]
  ]);
  const fetcher = async (url) => {
    const body = data.get(url);
    return body === undefined
      ? new globalThis.Response(null, { status: 404 })
      : new globalThis.Response(body, { status: 200 });
  };
  const loaded = await loadLive2DResources(modelUrl, fetcher);
  assert.equal(loaded.physicsPath, 'https://models.test/pack/settings/physics.json');
  assert.equal(loaded.motions.Idle[0].path, 'https://models.test/pack/motions/idle.motion3.json');
  assert.equal(
    loaded.expressions.Happy.path,
    'https://models.test/pack/expressions/happy.exp3.json'
  );
  data.delete('https://models.test/pack/expressions/happy.exp3.json');
  await assert.rejects(
    validateLive2DModel(modelUrl, fetcher),
    /required resource.*happy\.exp3\.json/
  );
});
