export const MEMORY_SCHEMA_VERSION = 1;

/** SQLite migration statements. The native adapter can execute these transactionally. */
export const MEMORY_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('system','user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER);`,
  `CREATE INDEX IF NOT EXISTS messages_conversation_time ON messages(conversation_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('preference','event','habit')), content TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id), confidence REAL NOT NULL, privacy TEXT NOT NULL CHECK(privacy IN ('private','normal','sensitive')), status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, embedding_model TEXT);`,
  `CREATE TABLE IF NOT EXISTS memory_tags (memory_id TEXT NOT NULL REFERENCES memories(id), tag TEXT NOT NULL, PRIMARY KEY(memory_id, tag));`,
  `CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id TEXT PRIMARY KEY REFERENCES memories(id), model_version TEXT NOT NULL, vector_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`
];

export type MigrationRunner = { transaction(statements: readonly string[]): Promise<void> };

export async function migrate(runner: MigrationRunner, currentVersion: number): Promise<number> {
  if (
    !Number.isInteger(currentVersion) ||
    currentVersion < 0 ||
    currentVersion > MEMORY_SCHEMA_VERSION
  ) {
    throw new Error(`Unsupported memory schema version: ${currentVersion}`);
  }
  if (currentVersion === MEMORY_SCHEMA_VERSION) return currentVersion;
  await runner.transaction(MEMORY_MIGRATIONS);
  return MEMORY_SCHEMA_VERSION;
}
