import { adminAuth, adminDb } from '@/lib/firebaseAdmin';

export type AuthContext = {
  uid: string;
  groupId: string;
};

export async function requireAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new Error('unauthorized');

  const decoded = await adminAuth().verifyIdToken(match[1]);
  const userSnap = await adminDb().collection('users').doc(decoded.uid).get();
  const groupId = String(userSnap.data()?.groupId || `group_${decoded.uid}`);
  return { uid: decoded.uid, groupId };
}

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
