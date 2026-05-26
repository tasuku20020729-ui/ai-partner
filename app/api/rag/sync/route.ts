import { adminDb } from '@/lib/firebaseAdmin';
import { buildRagText, embedText, ragDocId } from '@/lib/rag';
import { ragUpsertSchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const item = ragUpsertSchema.parse(await req.json());
    if (!auth.spaceIds.includes(item.groupId) || item.userId !== auth.uid) return unauthorized();
    if (item.aiReadable === false) return Response.json({ skipped: true, reason: 'aiReadable=false' });
    const text = buildRagText(item);
    const embedding = await embedText(text);
    await adminDb().collection('aiMemory').doc(ragDocId(item.type, item.id)).set({
      sourceId: item.id,
      sourceType: item.type,
      userId: item.userId || null,
      ownerName: item.ownerName || '',
      groupId: item.groupId,
      spaceId: item.spaceId || item.groupId,
      spaceName: item.spaceName || '',
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
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === 'unauthorized') return unauthorized();
    const invalid = validationError(e);
    if (invalid) return invalid;
    return Response.json({ error: e instanceof Error ? e.message : 'RAG sync failed' }, { status: 500 });
  }
}
