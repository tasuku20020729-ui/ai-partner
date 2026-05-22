import { adminDb } from '@/lib/firebaseAdmin';
import { buildRagText, embedText, ragDocId, type RagUpsertItem } from '@/lib/rag';

export async function POST(req: Request) {
  try {
    const item = await req.json() as RagUpsertItem;
    if (!item.id || !item.type || !item.groupId) return Response.json({ error: 'id, type, groupId are required' }, { status: 400 });
    if (item.aiReadable === false) return Response.json({ skipped: true, reason: 'aiReadable=false' });
    const text = buildRagText(item);
    const embedding = await embedText(text);
    await adminDb().collection('aiMemory').doc(ragDocId(item.type, item.id)).set({
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
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'RAG sync failed' }, { status: 500 });
  }
}
