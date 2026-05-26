import { adminAuth, adminDb } from '@/lib/firebaseAdmin';

export type AuthContext = {
  uid: string;
  groupId: string;
  personalSpaceId: string;
  activeSpaceId: string;
  spaceIds: string[];
};

export async function requireAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.get('authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new Error('unauthorized');

  const decoded = await adminAuth().verifyIdToken(match[1]);
  const userSnap = await adminDb().collection('users').doc(decoded.uid).get();
  const data = userSnap.data() || {};
  const personalSpaceId = String(data.personalSpaceId || `group_${decoded.uid}`);
  const activeSpaceId = String(data.activeSpaceId || data.groupId || personalSpaceId);
  const joinedSpaceIds = Array.isArray(data.joinedSpaceIds) ? data.joinedSpaceIds.map(String) : [];
  const spaceIds = Array.from(new Set([personalSpaceId, activeSpaceId, data.groupId, ...joinedSpaceIds].filter(Boolean).map(String)));
  return { uid: decoded.uid, groupId: activeSpaceId, personalSpaceId, activeSpaceId, spaceIds };
}

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
