import OpenAI from 'openai';

export type RagSourceType = 'diary' | 'event' | 'todo' | 'expense' | 'anniversary' | 'sharedNote';

export type RagUpsertItem = {
  id: string;
  type: RagSourceType;
  userId?: string;
  ownerName?: string;
  groupId: string;
  spaceId?: string;
  spaceName?: string;
  visibility?: 'private' | 'shared';
  aiReadable?: boolean;
  date?: string;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

export const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

export function ragDocId(type: string, id: string) {
  return `${type}_${id}`;
}

export function buildRagText(item: RagUpsertItem) {
  const meta = item.metadata || {};
  const parts = [
    `種類: ${item.type}`,
    item.date ? `日付: ${item.date}` : '',
    item.ownerName ? `所有者: ${item.ownerName}` : '',
    item.title ? `タイトル: ${item.title}` : '',
    item.content ? `本文: ${item.content}` : '',
    ...Object.entries(meta)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
  ].filter(Boolean);
  return parts.join('\n');
}

export async function embedText(text: string) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for RAG embeddings.');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.embeddings.create({ model: embeddingModel, input: text.slice(0, 7000) });
  return res.data[0].embedding;
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
