import { adminDb } from '@/lib/firebaseAdmin';
import { buildRagText, embedText, ragDocId, type RagUpsertItem } from '@/lib/rag';

export async function POST(req: Request) {
  try {
    const { items } = await req.json() as { items: RagUpsertItem[] };
    if (!Array.isArray(items)) return Response.json({ error: 'items must be array' }, { status: 400 });
    const db = adminDb();
    let synced = 0;
    let skipped = 0;
    for (const item of items.slice(0, 300)) {
      if (!item.id || !item.type || !item.groupId || item.aiReadable === false) { skipped++; continue; }
      const text = buildRagText(item);
      const embedding = await embedText(text);
      await db.collection('aiMemory').doc(ragDocId(item.type, item.id)).set({
        sourceId: item.id,
        sourceType: item.type,
        userId: item.userId || null,
        ownerName: item.ownerName || '',
        groupId: item.groupId,
        visibility: item.visibility || 'private',
        aiReadable: item.aiReadable !== false,
        date: item.date || '',
        title: item.title || '',
        contentText: text,
        metadata: item.metadata || {},
        embedding,
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
        updatedAt: new Date().toISOString()
      }, { merge: true });
      synced++;
    }
    return Response.json({ ok: true, synced, skipped });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'RAG batch failed' }, { status: 500 });
  }
}
