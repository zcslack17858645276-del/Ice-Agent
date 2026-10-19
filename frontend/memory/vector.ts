import type { MemoryRecord } from './types.ts';

export type VectorHit = { record: MemoryRecord; score: number; modelVersion: string };
export interface VectorStore {
  upsert(record: MemoryRecord, vector: readonly number[], modelVersion: string): Promise<void>;
  delete(id: string): Promise<void>;
  search(vector: readonly number[], modelVersion: string, limit: number): Promise<VectorHit[]>;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly entries = new Map<
    string,
    { record: MemoryRecord; vector: number[]; modelVersion: string }
  >();
  async upsert(
    record: MemoryRecord,
    vector: readonly number[],
    modelVersion: string
  ): Promise<void> {
    this.entries.set(record.id, { record, vector: [...vector], modelVersion });
  }
  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
  async search(
    vector: readonly number[],
    modelVersion: string,
    limit: number
  ): Promise<VectorHit[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.modelVersion === modelVersion && entry.record.status !== 'deleted')
      .map((entry) => ({ record: entry.record, modelVersion, score: cosine(vector, entry.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const norm = (values: readonly number[]) =>
    Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  const denominator = norm(left) * norm(right);
  return denominator ? dot / denominator : 0;
}
