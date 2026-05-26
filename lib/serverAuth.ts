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
  const candidateSpaceIds = Array.from(new Set([personalSpaceId, activeSpaceId, data.groupId, ...joinedSpaceIds].filter(Boolean).map(String))).slice(0, 50);
  const memberSnaps = await Promise.all(candidateSpaceIds.map(spaceId => adminDb().collection('spaces').doc(spaceId).collection('members').doc(decoded.uid).get()));
  const verifiedSpaceIds = candidateSpaceIds.filter((spaceId, index) => spaceId === personalSpaceId || memberSnaps[index].exists);
  const spaceIds = verifiedSpaceIds.length ? verifiedSpaceIds : [personalSpaceId];
  const verifiedActiveSpaceId = spaceIds.includes(activeSpaceId) ? activeSpaceId : personalSpaceId;
  return { uid: decoded.uid, groupId: verifiedActiveSpaceId, personalSpaceId, activeSpaceId: verifiedActiveSpaceId, spaceIds };
}

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
