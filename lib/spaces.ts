export const personalSpaceId = (uid: string) => `group_${uid}`;
export const personalSpaceName = '自分だけ';
export const sharedSpaceId = () => `space_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;

export const isPersonalSpaceId = (spaceId: string | undefined, uid: string) => spaceId === personalSpaceId(uid);

export const effectiveSpaceId = (item: { spaceId?: string; groupId?: string }) => item.spaceId || item.groupId || '';

export const legacyGroupIdToSpaceId = (groupId: string | undefined, uid: string) => groupId || personalSpaceId(uid);

export const scopeFieldsForSpace = (spaceId: string, spaceName?: string) => ({
  groupId: spaceId,
  spaceId,
  ...(spaceName ? { spaceName } : {})
});

export const personalSpaceFields = (uid: string) => ({
  personalSpaceId: personalSpaceId(uid),
  activeSpaceId: personalSpaceId(uid),
  groupId: personalSpaceId(uid),
  shareEnabled: false
});
