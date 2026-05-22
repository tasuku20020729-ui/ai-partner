import { NextRequest, NextResponse } from 'next/server';
import { adminDb, adminMessaging } from '@/lib/firebaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const { groupId, userId, title, body, url = '/' } = await req.json();
    if (!title || !body || (!groupId && !userId)) return NextResponse.json({ error: 'groupId or userId, title, body are required' }, { status: 400 });
    const db = adminDb();
    let q: any = db.collection('pushTokens');
    if (groupId) q = q.where('groupId', '==', groupId);
    if (userId) q = q.where('userId', '==', userId);
    const snap = await q.get();
    const tokens = [...new Set(snap.docs.map(d => d.data().token).filter(Boolean))];
    if (!tokens.length) return NextResponse.json({ ok: true, sent: 0 });
    const res = await adminMessaging().sendEachForMulticast({ tokens, notification: { title, body }, data: { title, body, url } });
    return NextResponse.json({ ok: true, sent: res.successCount, failed: res.failureCount });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'push failed' }, { status: 500 });
  }
}
