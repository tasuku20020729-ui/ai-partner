import { adminDb } from '@/lib/firebaseAdmin';
import { buildRagText, embedText, ragDocId } from '@/lib/rag';
import { ragBatchSchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { items } = ragBatchSchema.parse(await req.json());
    const db = adminDb();
    let synced = 0;
    let skipped = 0;
    for (const item of items) {
      if (item.aiReadable === false) { skipped++; continue; }
      if (item.groupId !== auth.groupId || item.userId !== auth.uid) { skipped++; continue; }
      const text = buildRagText(item);
      const embedding = await embedText(text);
      await db.collection('aiMemory').doc(ragDocId(item.type, item.id)).set({
        sourceId: item.id,
        sourceType: item.type,
        userId: item.userId || null,
        ownerName: item.ownerName || '',
        groupId: item.groupId,
        visibility: item.visibility || 'private',
        aiReadable: Boolean(item.aiReadable ?? true),
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
    if (e instanceof Error && e.message === 'unauthorized') return unauthorized();
    const invalid = validationError(e);
    if (invalid) return invalid;
    return Response.json({ error: e instanceof Error ? e.message : 'RAG batch failed' }, { status: 500 });
  }
}
