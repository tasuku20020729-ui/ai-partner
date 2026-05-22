import { adminDb } from '@/lib/firebaseAdmin';
import { ragDocId } from '@/lib/rag';

export async function POST(req: Request) {
  try {
    const { type, id } = await req.json() as { type: string; id: string };
    if (!type || !id) return Response.json({ error: 'type and id are required' }, { status: 400 });
    await adminDb().collection('aiMemory').doc(ragDocId(type, id)).delete();
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'RAG delete failed' }, { status: 500 });
  }
}
