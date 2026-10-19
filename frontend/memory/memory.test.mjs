import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryRepository } from './repository.ts';
import { extractCandidates } from './extractor.ts';
import { InMemoryVectorStore, cosine } from './vector.ts';
import { migrate, MEMORY_SCHEMA_VERSION } from './schema.ts';

test('repository validates, lists, and deletes memories', () => {
  const repository = new InMemoryRepository();
  repository.saveMessage({
    id: 'message-1',
    conversationId: 'conversation-1',
    role: 'user',
    content: 'I prefer tea.',
    createdAt: 1
  });
  const [record] =
    repository.createMemory({
      id: 'memory-1',
      kind: 'preference',
      content: 'I prefer tea.',
      sourceMessageId: 'message-1',
      confidence: 0.9,
      privacy: 'normal',
      createdAt: 1,
      tags: ['preference']
    }) && repository.listMemories();
  assert.equal(record.status, 'pending');
  repository.updateMemory(record.id, { status: 'confirmed' });
  assert.equal(repository.listMemories({ text: 'tea' }).length, 1);
  repository.deleteMemory(record.id);
  assert.equal(repository.listMemories().length, 0);
});

test('repository lists multiple conversations independently', () => {
  const repository = new InMemoryRepository();
  repository.saveMessage({
    id: 'a',
    conversationId: 'conversation-a',
    role: 'user',
    content: 'First chat',
    createdAt: 1
  });
  repository.saveMessage({
    id: 'b',
    conversationId: 'conversation-b',
    role: 'user',
    content: 'Second chat',
    createdAt: 2
  });
  assert.deepEqual(
    repository.listConversations().map((conversation) => conversation.id),
    ['conversation-b', 'conversation-a']
  );
  assert.equal(repository.listConversations()[0].preview, 'Second chat');
});

test('extractor excludes sensitive content and emits traceable candidates', () => {
  const message = {
    id: 'message-2',
    conversationId: 'c',
    role: 'user',
    content: 'I usually walk every morning.',
    createdAt: 2
  };
  assert.equal(extractCandidates(message).at(0)?.sourceMessageId, message.id);
  assert.deepEqual(extractCandidates({ ...message, content: 'My password is secret.' }), []);
});

test('vector fallback scores compatible model versions', async () => {
  const store = new InMemoryVectorStore();
  const record = {
    id: 'm',
    kind: 'habit',
    content: 'walk',
    sourceMessageId: 's',
    confidence: 1,
    privacy: 'normal',
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    tags: []
  };
  await store.upsert(record, [1, 0], 'test-v1');
  assert.equal((await store.search([1, 0], 'test-v1', 5))[0].score, 1);
  assert.equal((await store.search([1, 0], 'other', 5)).length, 0);
  assert.equal(cosine([1], [0]), 0);
});

test('migration is idempotent and records the target version', async () => {
  let calls = 0;
  const runner = {
    transaction: async () => {
      calls += 1;
    }
  };
  assert.equal(await migrate(runner, 0), MEMORY_SCHEMA_VERSION);
  assert.equal(await migrate(runner, MEMORY_SCHEMA_VERSION), MEMORY_SCHEMA_VERSION);
  assert.equal(calls, 1);
});
