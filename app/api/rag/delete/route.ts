import { adminDb } from '@/lib/firebaseAdmin';
import { ragDeleteSchema, validationError } from '@/lib/apiSchemas';
import { ragDocId } from '@/lib/rag';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

export async function POST(req: Request) {
  try {
    const auth = await requireAuth(req);
    const { type, id } = ragDeleteSchema.parse(await req.json());
    const ref = adminDb().collection('aiMemory').doc(ragDocId(type, id));
    const snap = await ref.get();
    const data = snap.data();
    if (snap.exists && (data?.groupId !== auth.groupId || data?.userId !== auth.uid)) return unauthorized();
    await ref.delete();
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === 'unauthorized') return unauthorized();
    const invalid = validationError(e);
    if (invalid) return invalid;
    return Response.json({ error: e instanceof Error ? e.message : 'RAG delete failed' }, { status: 500 });
  }
}
