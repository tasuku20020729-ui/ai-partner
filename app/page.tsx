'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { auth, db, storage } from '@/lib/firebase';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, increment, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Bell, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, Gift, Home, MessageCircle, NotebookPen, ReceiptText, Settings, StickyNote, Users, Copy, Share2 } from 'lucide-react';
import { todayIso, toDateTimeLocalValue } from '@/lib/date';
import { enablePwaPush } from '@/lib/push';
import { personalSpaceId, personalSpaceName, scopeFieldsForSpace, sharedSpaceId } from '@/lib/spaces';
import type { Anniversary, Currency, Diary, EventItem, Expense, ExpenseCategory, SharedNote, Space, SpaceMember, SpaceType, Todo, Visibility } from '@/types/app';

type Tab = 'home' | 'diary' | 'calendar' | 'todo' | 'expense' | 'ai' | 'notes' | 'settings';
type AddMode = 'diary' | 'event' | 'todo' | 'expense' | 'anniversary' | 'note' | null;
type ChatMessage = { role: 'user' | 'ai'; content: string };
type EditTarget = { mode: Exclude<AddMode, null>; id: string; data: Record<string, any> } | null;
type SpaceSummary = Pick<Space, 'id' | 'name' | 'type'>;
type MemberProfile = SpaceMember & { spaceName?: string };

const categories: { value: ExpenseCategory; label: string }[] = [
  { value: 'food', label: '食費' }, { value: 'daily_goods', label: '日用品' }, { value: 'dating', label: '交際費' }, { value: 'transport', label: '交通費' }, { value: 'travel', label: '旅行' }, { value: 'medical', label: '医療費' }, { value: 'entertainment', label: '娯楽' }, { value: 'other', label: 'その他' }
];
const categoryLabel = Object.fromEntries(categories.map(c => [c.value, c.label]));
const priorityLabel = { high: '高', middle: '中', low: '低' };
const ratesToJpy: Record<Currency, number> = { JPY: 1, MYR: 33, USD: 155 }; // 自動取得は設計から除外。設定値として固定。
const newGroupId = personalSpaceId;
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;
const datePart = (s?: string) => {
  if (!s) return '';
  if (!s.includes('T')) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
};
const authedHeaders = async (user: User) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` });
const mergeDocs = <T extends { id: string }>(...lists: T[][]) => Array.from(new Map(lists.flat().map(item => [item.id, item])).values());
const monthLabel = (isoDate: string) => new Date(`${isoDate.slice(0, 7)}-01T00:00:00+09:00`).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
const addMonths = (isoDate: string, months: number) => {
  const d = new Date(`${isoDate.slice(0, 7)}-01T00:00:00+09:00`);
  d.setMonth(d.getMonth() + months);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};
const dateFromMonthDay = (monthIso: string, day: number) => `${monthIso.slice(0, 7)}-${String(day).padStart(2, '0')}`;
const dateTimeOnDate = (date: string, time = '09:00') => `${date}T${time}`;
const inviteCode = () => `PAIR-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const csvToList = (value: string) => Array.from(new Set(value.split(/[,、]/).map(v => v.trim()).filter(Boolean)));
const listToCsv = (value?: string[]) => (value || []).join(', ');
const partnerFieldValue = (value: unknown, configured?: unknown) => {
  if (typeof value !== 'string') return '';
  if (value === '彼女' && configured !== true && configured !== 'true') return '';
  return value;
};
const toDateTimeLocal = (value?: string) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 16);
  return toDateTimeLocalValue(d);
};
const locationNameFrom = (item: any) => typeof item.location === 'string' ? item.location : '';

function toRagItem(type: AddMode | string, id: string, item: Record<string, any>) {
  if (!type || type === 'note') {
    return {
      id,
      type: 'sharedNote',
      userId: item.createdBy || item.userId,
      ownerName: item.createdByName || item.ownerName,
      groupId: item.groupId,
      spaceId: item.spaceId || item.groupId,
      spaceName: item.spaceName,
      visibility: 'shared',
      aiReadable: true,
      date: item.updatedAt || item.createdAt,
      title: item.title,
      content: item.content,
      metadata: {}
    };
  }
  const sourceType = type === 'diary' ? 'diary' : type === 'event' ? 'event' : type === 'todo' ? 'todo' : type === 'expense' ? 'expense' : 'anniversary';
  const content = [item.content, item.description, item.memo, type === 'event' ? item.location : '', item.shopName].filter(Boolean).join('\n');
  return {
    id,
    type: sourceType,
    userId: item.userId,
    ownerName: item.ownerName,
    groupId: item.groupId,
    spaceId: item.spaceId || item.groupId,
    spaceName: item.spaceName,
    visibility: item.visibility || 'private',
    aiReadable: item.aiReadable ?? true,
    date: item.date || item.startAt || item.dueAt || item.createdAt,
    title: item.title,
    content,
    metadata: {
      mood: item.mood,
      tags: item.tags,
      category: item.category,
      amount: item.amount,
      currency: item.currency,
      amountBase: item.amountBase,
      status: item.status,
      priority: item.priority,
      startAt: item.startAt,
      endAt: item.endAt,
      dueAt: item.dueAt,
      repeat: item.repeat
    }
  };
}


export default function Page() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('home');
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [groupId, setGroupId] = useState('');
  const [shareEnabled, setShareEnabled] = useState(false);
  const [activeSpaceName, setActiveSpaceName] = useState(personalSpaceName);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [spaceMembers, setSpaceMembers] = useState<MemberProfile[]>([]);
  const [viewAllSpaces, setViewAllSpaces] = useState(false);
  const [partnerName, setPartnerName] = useState('');
  const [partnerRelationship, setPartnerRelationship] = useState('');
  const [dataLoading, setDataLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [diaries, setDiaries] = useState<Diary[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([{ role: 'ai', content: '日記・予定・ToDo・支出・記念日・共有メモを横断検索できます。例:「明後日の予定は？」「今週の課題は？」「先週いくら使った？」' }]);
  const [question, setQuestion] = useState('');
  const [saving, setSaving] = useState(false);
  const [operationMessage, setOperationMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [pushStatus, setPushStatus] = useState('未設定');
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [calendarMonth, setCalendarMonth] = useState(todayIso());
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [naturalDraft, setNaturalDraft] = useState<Record<string, any> | null>(null);
  const activeSpaceIds = useMemo(() => {
    const ids = spaces.map(space => space.id).filter(Boolean);
    return ids.length ? ids : (user ? [newGroupId(user.uid)] : []);
  }, [spaces, user?.uid]);
  const visibleSpaceIds = useMemo(() => viewAllSpaces ? activeSpaceIds : (groupId ? [groupId] : []), [activeSpaceIds, groupId, viewAllSpaces]);

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    try {
      setUser(u);
      if (u) {
        const userRef = doc(db, 'users', u.uid);
        const userSnap = await getDoc(userRef);
        const uidPersonalSpaceId = personalSpaceId(u.uid);
        const savedGroupId = userSnap.data()?.groupId;
        const savedActiveSpaceId = userSnap.data()?.activeSpaceId;
        const savedPersonalSpaceId = userSnap.data()?.personalSpaceId;
        const cachedGroupId = localStorage.getItem(`groupId_${u.uid}`);
        const savedShareEnabled = userSnap.data()?.shareEnabled === true;
        const cachedShareEnabled = localStorage.getItem(`shareEnabled_${u.uid}`) === 'true';
        const nextShareEnabled = savedShareEnabled || cachedShareEnabled;
        const personalId = savedPersonalSpaceId || uidPersonalSpaceId;
        const gid = nextShareEnabled ? (savedActiveSpaceId || savedGroupId || cachedGroupId || personalId) : personalId;
        const joinedSpaceIds = Array.from(new Set([personalId, gid, ...(Array.isArray(userSnap.data()?.joinedSpaceIds) ? userSnap.data()?.joinedSpaceIds : [])].filter(Boolean)));
        const savedPartnerName = userSnap.data()?.partnerName;
        const savedPartnerRelationship = userSnap.data()?.partnerRelationship;
        const savedPartnerProfileConfigured = userSnap.data()?.partnerProfileConfigured;
        const cachedPartnerProfileConfigured = localStorage.getItem(`partnerProfileConfigured_${u.uid}`);
        setGroupId(gid);
        setShareEnabled(nextShareEnabled);
        setViewAllSpaces(false);
        localStorage.setItem(`groupId_${u.uid}`, gid);
        localStorage.setItem(`shareEnabled_${u.uid}`, nextShareEnabled ? 'true' : 'false');
        const activeSpaceSnap = gid === personalId ? null : await getDoc(doc(db, 'spaces', gid)).catch(() => null);
        const nextActiveSpaceName = activeSpaceSnap?.data()?.name || (gid === personalId ? personalSpaceName : '共有スペース');
        setActiveSpaceName(nextActiveSpaceName);
        const nextPartnerName = partnerFieldValue(savedPartnerName || localStorage.getItem(`partnerName_${u.uid}`), savedPartnerProfileConfigured || cachedPartnerProfileConfigured);
        const nextPartnerRelationship = partnerFieldValue(savedPartnerRelationship || localStorage.getItem(`partnerRelationship_${u.uid}`), savedPartnerProfileConfigured || cachedPartnerProfileConfigured);
        setPartnerName(nextPartnerName);
        setPartnerRelationship(nextPartnerRelationship);
        setNotificationEnabled(localStorage.getItem(`notify_${u.uid}`) === 'on');
        const now = new Date().toISOString();
        await setDoc(doc(db, 'spaces', personalId), { name: personalSpaceName, type: 'personal', ownerId: u.uid, createdAt: userSnap.data()?.createdAt || now, updatedAt: now }, { merge: true });
        await setDoc(doc(db, 'spaces', personalId, 'members', u.uid), { id: u.uid, spaceId: personalId, spaceName: personalSpaceName, userId: u.uid, displayName: u.displayName || u.email || '自分', role: 'owner', relationshipLabels: ['自分'], aliases: ['自分', '私', '自分だけ'], joinedAt: userSnap.data()?.createdAt || now, updatedAt: now }, { merge: true });
        await setDoc(userRef, { name: u.displayName || u.email || 'User', email: u.email, defaultCurrency: 'JPY', personalSpaceId: personalId, activeSpaceId: gid, groupId: gid, joinedSpaceIds, shareEnabled: nextShareEnabled, partnerName: nextPartnerName, partnerRelationship: nextPartnerRelationship, partnerProfileConfigured: Boolean(nextPartnerName || nextPartnerRelationship), updatedAt: now }, { merge: true });
        await loadJoinedSpaces(u.uid, personalId, joinedSpaceIds);
        await loadAll(u.uid, gid);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'ログイン情報の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }), []);

  useEffect(() => {
    if (!user || !notificationEnabled) return;
    const id = setInterval(() => checkReminders(), 60000);
    checkReminders();
    return () => clearInterval(id);
  }, [user, notificationEnabled, todos, events, anniversaries]);

  useEffect(() => {
    const uid = user?.uid;
    const targetSpaceIds = visibleSpaceIds.length ? visibleSpaceIds : (groupId ? [groupId] : []);
    if (!uid || !targetSpaceIds.length) return;
    setLoadError('');

    const byDesc = (key: string) => (a: any, b: any) => String(b[key] || '').localeCompare(String(a[key] || ''));
    const byAsc = (key: string) => (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || ''));
    const handleSyncError = (e: unknown) => setLoadError(e instanceof Error ? e.message : '共有データの自動同期に失敗しました');
    const subscribeScoped = <T extends { id: string }>(col: string, setItems: (items: T[]) => void, sortItems: (a: T, b: T) => number) => {
      const own = new Map<string, T[]>();
      const shared = new Map<string, T[]>();
      const loaded = new Set<string>();
      const publish = () => {
        if (loaded.size < targetSpaceIds.length * 2) return;
        setItems(mergeDocs(...Array.from(own.values()), ...Array.from(shared.values())).sort(sortItems));
      };
      const unsubs = targetSpaceIds.flatMap(spaceId => [
        onSnapshot(
          query(collection(db, col), where('userId', '==', uid), where('groupId', '==', spaceId)),
          snap => { own.set(spaceId, snap.docs.map(v => ({ id: v.id, ...v.data() } as T))); loaded.add(`${spaceId}:own`); publish(); },
          handleSyncError
        ),
        onSnapshot(
          query(collection(db, col), where('groupId', '==', spaceId), where('visibility', '==', 'shared')),
          snap => { shared.set(spaceId, snap.docs.map(v => ({ id: v.id, ...v.data() } as T))); loaded.add(`${spaceId}:shared`); publish(); },
          handleSyncError
        )
      ]);
      return () => unsubs.forEach(unsub => unsub());
    };
    const subscribeNotes = () => {
      const notes = new Map<string, SharedNote[]>();
      const loaded = new Set<string>();
      const publish = () => {
        if (loaded.size < targetSpaceIds.length) return;
        setSharedNotes(mergeDocs(...Array.from(notes.values())).sort(byDesc('createdAt')));
      };
      const unsubs = targetSpaceIds.map(spaceId => onSnapshot(
        query(collection(db, 'sharedNotes'), where('groupId', '==', spaceId)),
        snap => { notes.set(spaceId, snap.docs.map(v => ({ id: v.id, ...v.data() } as SharedNote))); loaded.add(spaceId); publish(); },
        handleSyncError
      ));
      return () => unsubs.forEach(unsub => unsub());
    };

    const unsubs = [
      subscribeScoped<Diary>('diaries', setDiaries, byDesc('date')),
      subscribeScoped<EventItem>('events', setEvents, byAsc('startAt')),
      subscribeScoped<Todo>('todos', setTodos, byDesc('createdAt')),
      subscribeScoped<Expense>('expenses', setExpenses, byDesc('date')),
      subscribeScoped<Anniversary>('anniversaries', setAnniversaries, byAsc('date')),
      subscribeNotes()
    ];

    return () => unsubs.forEach(unsub => unsub());
  }, [user?.uid, groupId, visibleSpaceIds]);

  async function loadAll(uid = user?.uid, gid: string | string[] = groupId) {
    const targetSpaceIds = Array.isArray(gid) ? gid.filter(Boolean) : [gid].filter(Boolean);
    if (!uid || !targetSpaceIds.length) return;
    setDataLoading(true);
    setLoadError('');
    try {
      const readScoped = async <T extends { id: string }>(col: string) => {
        const snaps = await Promise.all(targetSpaceIds.flatMap(spaceId => [
          getDocs(query(collection(db, col), where('userId', '==', uid), where('groupId', '==', spaceId))),
          getDocs(query(collection(db, col), where('groupId', '==', spaceId), where('visibility', '==', 'shared')))
        ]));
        return mergeDocs(...snaps.map(snap => snap.docs.map(v => ({ id: v.id, ...v.data() } as T))));
      };
      const [d, e, t, x, a, n] = await Promise.all([
        readScoped<Diary>('diaries'),
        readScoped<EventItem>('events'),
        readScoped<Todo>('todos'),
        readScoped<Expense>('expenses'),
        readScoped<Anniversary>('anniversaries'),
        Promise.all(targetSpaceIds.map(spaceId => getDocs(query(collection(db, 'sharedNotes'), where('groupId', '==', spaceId)))))
      ]);
      const byDesc = (key: string) => (a: any, b: any) => String(b[key] || '').localeCompare(String(a[key] || ''));
      const byAsc = (key: string) => (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || ''));
      setDiaries(d.sort(byDesc('date')));
      setEvents(e.sort(byAsc('startAt')));
      setTodos(t.sort(byDesc('createdAt')));
      setExpenses(x.sort(byDesc('date')));
      setAnniversaries(a.sort(byAsc('date')));
      setSharedNotes(mergeDocs(...n.map(snap => snap.docs.map(v => ({ id: v.id, ...v.data() } as SharedNote)))).sort(byDesc('createdAt')));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'データの読み込みに失敗しました');
    } finally {
      setDataLoading(false);
    }
  }

  async function loadJoinedSpaces(uid = user?.uid, fallbackPersonalId = user ? newGroupId(user.uid) : '', knownSpaceIds?: string[]) {
    if (!uid) return;
    const personalId = fallbackPersonalId || newGroupId(uid);
    try {
      const userSnap = await getDoc(doc(db, 'users', uid));
      const data = userSnap.data() || {};
      const ids = Array.from(new Set([personalId, data.activeSpaceId, data.groupId, ...(knownSpaceIds || []), ...(Array.isArray(data.joinedSpaceIds) ? data.joinedSpaceIds : [])].map(String).filter(Boolean)));
      const loaded = await Promise.all(ids.map(async id => {
        const memberSnap = await getDoc(doc(db, 'spaces', id, 'members', uid)).catch(() => null);
        if (id !== personalId && !memberSnap?.exists()) return null;
        const member = memberSnap?.data();
        const spaceSnap = await getDoc(doc(db, 'spaces', id)).catch(() => null);
        const spaceData = spaceSnap?.data();
        return {
          id,
          name: String(spaceData?.name || member?.spaceName || (id === personalId ? personalSpaceName : '共有スペース')),
          type: (spaceData?.type || (id === personalId ? 'personal' : 'group')) as SpaceType
        };
      }));
      const sorted = loaded.filter((space): space is SpaceSummary => Boolean(space)).sort((a, b) => Number(a.type !== 'personal') - Number(b.type !== 'personal') || a.name.localeCompare(b.name, 'ja'));
      setSpaces(sorted);
      await loadSpaceMembers(sorted);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'スペース一覧の読み込みに失敗しました');
    }
  }

  async function loadSpaceMembers(spaceList = spaces) {
    if (!spaceList.length) {
      setSpaceMembers([]);
      return;
    }
    try {
      const snaps = await Promise.all(spaceList.map(space => getDocs(collection(db, 'spaces', space.id, 'members')).then(snap => ({ space, snap }))));
      setSpaceMembers(snaps.flatMap(({ space, snap }) => snap.docs.map(memberDoc => ({ id: memberDoc.id, ...memberDoc.data(), spaceName: space.name } as MemberProfile))));
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'メンバー情報の読み込みに失敗しました');
    }
  }

  async function login(register = false) {
    setSaving(true);
    try {
      const cred = register ? await createUserWithEmailAndPassword(auth, email, password) : await signInWithEmailAndPassword(auth, email, password);
      if (register && name) await updateProfile(cred.user, { displayName: name });
    } catch (e) { alert(e instanceof Error ? e.message : 'ログインに失敗しました'); }
    finally { setSaving(false); }
  }

  const visible = useMemo(() => {
    const readable = (v: { userId: string; visibility: Visibility; aiReadable: boolean }) => v.userId === user?.uid || (v.visibility === 'shared' && v.aiReadable);
    return { diaries: diaries.filter(readable), events: events.filter(readable), todos: todos.filter(readable), expenses: expenses.filter(readable), anniversaries: anniversaries.filter(readable), sharedNotes };
  }, [diaries, events, todos, expenses, anniversaries, sharedNotes, user?.uid]);

  const monthExpense = expenses.filter(e => e.date?.startsWith(todayIso().slice(0, 7))).reduce((s, e) => s + Number(e.amountBase || 0), 0);
  const sharedStats = useMemo(() => {
    const sharedItems = [...diaries, ...events, ...todos, ...expenses, ...anniversaries].filter((item: any) => item.visibility === 'shared');
    const partnerItems = sharedItems.filter((item: any) => item.userId !== user?.uid);
    return {
      sharedCount: sharedItems.length + sharedNotes.length,
      partnerCount: partnerItems.length,
      notesCount: sharedNotes.length
    };
  }, [diaries, events, todos, expenses, anniversaries, sharedNotes, user?.uid]);
  const openTodos = todos.filter(t => t.status === 'open');
  const todayEvents = events.filter(e => datePart(e.startAt) === todayIso());
  const memoryCards = buildMemoryCards(diaries, expenses, events, anniversaries);
  const reminderCards = buildReminderCards(todos, events, anniversaries);
  const openAddForDate = (mode: AddMode, date = selectedDate) => {
    setNaturalDraft(null);
    setSelectedDate(date);
    setCalendarMonth(date);
    setDatePickerOpen(false);
    setEditTarget(null);
    setAddMode(mode);
  };
  const openEdit = (mode: Exclude<AddMode, null>, item: Record<string, any>) => {
    setNaturalDraft(null);
    const date = item.date || datePart(item.startAt) || item.dueAt || selectedDate;
    setSelectedDate(date);
    setCalendarMonth(date);
    setDatePickerOpen(false);
    setEditTarget({ mode, id: item.id, data: item });
    setAddMode(mode);
  };
  const chooseDate = (date: string) => {
    setSelectedDate(date);
    setCalendarMonth(date);
    setDatePickerOpen(true);
  };

  if (loading) return <div className="shell"><main className="content"><div className="card">読み込み中...</div></main></div>;
  if (!user) return <Login name={name} setName={setName} email={email} setEmail={setEmail} password={password} setPassword={setPassword} login={login} saving={saving} />;

  return <div className="shell">
    <header className="top"><div className="brand"><div><h1>AI Life Diary v5</h1><p>カレンダー・ToDo・日記・支出</p></div><div className="avatar">{(user.displayName || user.email || 'U').slice(0, 1).toUpperCase()}</div></div></header>
    <main className="content">
      {loadError && <div className="error-card"><div><b>データを読み込めませんでした</b><p>{loadError}</p></div><button className="btn secondary" disabled={dataLoading} onClick={() => loadAll(user.uid, visibleSpaceIds.length ? visibleSpaceIds : groupId)}>{dataLoading ? '再読み込み中...' : '再読み込み'}</button></div>}
      {operationError && <div className="error-card"><div><b>操作に失敗しました</b><p>{operationError}</p></div><button className="btn secondary" onClick={() => setOperationError('')}>閉じる</button></div>}
      {operationMessage && <div className="sync-status">{operationMessage}</div>}
      {dataLoading && !loadError && <div className="sync-status">データを更新しています...</div>}
      {tab === 'home' && <CalendarHomeView selectedDate={selectedDate} setSelectedDate={setSelectedDate} chooseDate={chooseDate} calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth} diaries={diaries} events={events} todos={todos} expenses={expenses} anniversaries={anniversaries} monthExpense={monthExpense} openAdd={openAddForDate} onEdit={openEdit} onDelete={remove} currentUserId={user.uid} naturalAdd={naturalAdd} setTab={setTab} saving={saving} spaces={spaces} groupId={groupId} viewAllSpaces={viewAllSpaces} activeSpaceIds={activeSpaceIds} switchSpace={switchSpace} switchAllSpaces={switchAllSpaces} />}
      {tab === 'diary' && <DiaryView diaries={diaries} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} />}
      {tab === 'calendar' && <CalendarHomeView selectedDate={selectedDate} setSelectedDate={setSelectedDate} chooseDate={chooseDate} calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth} diaries={diaries} events={events} todos={todos} expenses={expenses} anniversaries={anniversaries} monthExpense={monthExpense} openAdd={openAddForDate} onEdit={openEdit} onDelete={remove} currentUserId={user.uid} naturalAdd={naturalAdd} setTab={setTab} saving={saving} spaces={spaces} groupId={groupId} viewAllSpaces={viewAllSpaces} activeSpaceIds={activeSpaceIds} switchSpace={switchSpace} switchAllSpaces={switchAllSpaces} />}
      {tab === 'todo' && <TodoView todos={todos} currentUserId={user.uid} toggleTodo={toggleTodo} onEdit={openEdit} onDelete={remove} />}
      {tab === 'expense' && <ExpenseView expenses={expenses} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'ai' && <AIView chat={chat} question={question} setQuestion={setQuestion} ask={askAI} saving={saving} />}
      {tab === 'notes' && <NotesView notes={sharedNotes} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'settings' && <SettingsView user={user} groupId={groupId} shareEnabled={shareEnabled} activeSpaceName={activeSpaceName} spaces={spaces} spaceMembers={spaceMembers} setGroupId={saveGroupId} createSpace={createSpace} renameSpace={renameSpace} leaveSpace={leaveSpace} createInvite={createInviteForActiveSpace} revokeInvite={revokeInvite} joinInvite={joinInvite} partnerName={partnerName} partnerRelationship={partnerRelationship} savePartnerProfile={savePartnerProfile} saveMemberProfile={saveMemberProfile} reload={() => loadAll(user.uid, visibleSpaceIds.length ? visibleSpaceIds : groupId)} notificationEnabled={notificationEnabled} setNotificationEnabled={enableNotifications} pushStatus={pushStatus} enablePush={enablePushNotifications} repairSearchIndex={repairSearchIndex} saving={saving} sharedStats={sharedStats} />}
    </main>
    <BottomNav tab={tab} setTab={setTab} />
    {datePickerOpen && <DateActionSheet selectedDate={selectedDate} close={() => setDatePickerOpen(false)} openAdd={openAddForDate} />}
    {addMode && <AddModal mode={addMode} setMode={setAddMode} close={() => { setNaturalDraft(null); setEditTarget(null); setAddMode(null); }} save={saveDoc} user={user} spaces={spaces} activeSpaceId={groupId} activeSpaceName={activeSpaceName} partnerName={partnerName} selectedDate={selectedDate} editTarget={editTarget} draftData={naturalDraft} saving={saving} />}
  </div>;

  async function syncSearchIndex(type: AddMode | string, id: string, item: Record<string, any>) {
    if (!user) return;
    const shouldSync = type === 'note' || item.aiReadable !== false;
    const body = shouldSync ? toRagItem(type, id, item) : { type: type === 'note' ? 'sharedNote' : type, id };
    const res = await fetch(shouldSync ? '/api/rag/sync' : '/api/rag/delete', {
      method: 'POST',
      headers: await authedHeaders(user),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || 'AI検索への同期に失敗しました');
    }
  }

  async function remove(type: string, id: string) {
    if (saving) return;
    if (!confirm('削除しますか？')) return;
    setSaving(true);
    setOperationError('');
    setOperationMessage('削除しています...');
    try {
      const map: Record<string, string> = { diary: 'diaries', event: 'events', todo: 'todos', expense: 'expenses', anniversary: 'anniversaries', note: 'sharedNotes' };
      await deleteDoc(doc(db, map[type], id));
      const res = await fetch('/api/rag/delete', { method: 'POST', headers: await authedHeaders(user!), body: JSON.stringify({ type: type === 'note' ? 'sharedNote' : type, id }) });
      if (!res.ok) throw new Error('データは削除しましたが、AI検索からの削除同期に失敗しました');
      if (editTarget?.id === id) setEditTarget(null);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : '削除に失敗しました');
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function toggleTodo(todo: Todo) {
    const updated = { ...todo, status: todo.status === 'done' ? 'open' : 'done', updatedAt: new Date().toISOString() } as Todo;
    await updateDoc(doc(db, 'todos', todo.id), { status: updated.status, updatedAt: updated.updatedAt });
    await syncSearchIndex('todo', todo.id, updated);
  }
  async function saveGroupId(v: string) {
    if (!user) return;
    const nextGroupId = v.trim();
    if (!nextGroupId) {
      alert('共有IDを入力してください');
      return;
    }
    const previousGroupId = groupId;
    const previousShareEnabled = shareEnabled;
    const previousActiveSpaceName = activeSpaceName;
    const nextShareEnabled = nextGroupId !== newGroupId(user.uid);
    setGroupId(nextGroupId);
    setShareEnabled(nextShareEnabled);
    setViewAllSpaces(false);
    setActiveSpaceName(nextShareEnabled ? activeSpaceName || '共有スペース' : personalSpaceName);
    try {
      await setDoc(doc(db, 'users', user.uid), { groupId: nextGroupId, activeSpaceId: nextGroupId, joinedSpaceIds: Array.from(new Set([...activeSpaceIds, nextGroupId, newGroupId(user.uid)].filter(Boolean))), shareEnabled: nextShareEnabled, updatedAt: new Date().toISOString() }, { merge: true });
      localStorage.setItem(`groupId_${user.uid}`, nextGroupId);
      localStorage.setItem(`shareEnabled_${user.uid}`, nextShareEnabled ? 'true' : 'false');
      await loadAll(user.uid, nextGroupId);
    } catch (e) {
      setGroupId(previousGroupId);
      setShareEnabled(previousShareEnabled);
      setActiveSpaceName(previousActiveSpaceName);
      alert(e instanceof Error ? e.message : '共有IDの保存に失敗しました');
    }
  }
  async function switchSpace(space: SpaceSummary) {
    if (!user || saving) return false;
    if (space.id === groupId && !viewAllSpaces) return true;
    if (space.id === groupId && viewAllSpaces) {
      setViewAllSpaces(false);
      await loadAll(user.uid, space.id);
      return true;
    }
    const previousGroupId = groupId;
    const previousShareEnabled = shareEnabled;
    const previousActiveSpaceName = activeSpaceName;
    const nextShareEnabled = space.id !== newGroupId(user.uid);
    setGroupId(space.id);
    setShareEnabled(nextShareEnabled);
    setViewAllSpaces(false);
    setActiveSpaceName(space.name);
    setOperationError('');
    setOperationMessage('スペースを切り替えています...');
    try {
      await setDoc(doc(db, 'users', user.uid), { groupId: space.id, activeSpaceId: space.id, joinedSpaceIds: Array.from(new Set([...activeSpaceIds, space.id, newGroupId(user.uid)].filter(Boolean))), shareEnabled: nextShareEnabled, updatedAt: new Date().toISOString() }, { merge: true });
      localStorage.setItem(`groupId_${user.uid}`, space.id);
      localStorage.setItem(`shareEnabled_${user.uid}`, nextShareEnabled ? 'true' : 'false');
      await loadAll(user.uid, space.id);
      return true;
    } catch (e) {
      setGroupId(previousGroupId);
      setShareEnabled(previousShareEnabled);
      setActiveSpaceName(previousActiveSpaceName);
      setOperationError(e instanceof Error ? e.message : 'スペースの切り替えに失敗しました');
      return false;
    } finally {
      setOperationMessage('');
    }
  }
  async function switchAllSpaces() {
    if (!user || saving) return false;
    const targetSpaceIds = activeSpaceIds.length ? activeSpaceIds : [newGroupId(user.uid)];
    setViewAllSpaces(true);
    setOperationError('');
    setOperationMessage('すべてのスペースを読み込んでいます...');
    try {
      await loadAll(user.uid, targetSpaceIds);
      return true;
    } catch (e) {
      setViewAllSpaces(false);
      setOperationError(e instanceof Error ? e.message : 'すべてのスペースの読み込みに失敗しました');
      return false;
    } finally {
      setOperationMessage('');
    }
  }
  async function createSpace(name: string, type: SpaceType) {
    if (!user) return false;
    const spaceName = name.trim();
    if (!spaceName) {
      alert('スペース名を入力してください');
      return false;
    }
    if (saving) return false;
    setSaving(true);
    setOperationError('');
    setOperationMessage('共有スペースを作成しています...');
    const previousGroupId = groupId;
    const previousShareEnabled = shareEnabled;
    const previousActiveSpaceName = activeSpaceName;
    const spaceId = sharedSpaceId();
    const now = new Date().toISOString();
    try {
      await setDoc(doc(db, 'spaces', spaceId), { name: spaceName, type, ownerId: user.uid, createdAt: now, updatedAt: now });
      await setDoc(doc(db, 'spaces', spaceId, 'members', user.uid), { id: user.uid, spaceId, spaceName, userId: user.uid, displayName: user.displayName || user.email || '自分', role: 'owner', relationshipLabels: ['自分'], aliases: ['自分', '私'], joinedAt: now, updatedAt: now });
      const nextJoinedSpaceIds = Array.from(new Set([...activeSpaceIds, spaceId, newGroupId(user.uid)].filter(Boolean)));
      await setDoc(doc(db, 'users', user.uid), { groupId: spaceId, activeSpaceId: spaceId, joinedSpaceIds: nextJoinedSpaceIds, shareEnabled: true, updatedAt: now }, { merge: true });
      setGroupId(spaceId);
      setShareEnabled(true);
      setViewAllSpaces(false);
      setActiveSpaceName(spaceName);
      localStorage.setItem(`groupId_${user.uid}`, spaceId);
      localStorage.setItem(`shareEnabled_${user.uid}`, 'true');
      setSpaces(prev => mergeDocs<SpaceSummary>(prev, [{ id: spaceId, name: spaceName, type }]).sort((a, b) => Number(a.type !== 'personal') - Number(b.type !== 'personal') || a.name.localeCompare(b.name, 'ja')));
      await loadAll(user.uid, spaceId);
      await loadJoinedSpaces(user.uid, newGroupId(user.uid), nextJoinedSpaceIds);
      return spaceId;
    } catch (e) {
      setGroupId(previousGroupId);
      setShareEnabled(previousShareEnabled);
      setActiveSpaceName(previousActiveSpaceName);
      setOperationError(e instanceof Error ? e.message : '共有スペースの作成に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function createInviteForActiveSpace(targetSpaceId?: string) {
    if (!user) return '';
    const spaceId = targetSpaceId || groupId;
    const targetSpace = spaces.find(space => space.id === spaceId);
    if (!spaceId || spaceId === newGroupId(user.uid) || targetSpace?.type === 'personal') {
      alert('先に招待する共有スペースを選択してください');
      return '';
    }
    setSaving(true);
    setOperationError('');
    setOperationMessage('招待コードを作成しています...');
    try {
      const code = inviteCode();
      const now = new Date().toISOString();
      await setDoc(doc(db, 'invites', code), {
        id: code,
        code,
        spaceId,
        spaceName: targetSpace?.name || activeSpaceName || '共有スペース',
        createdBy: user.uid,
        status: 'active',
        usedCount: 0,
        createdAt: now,
        updatedAt: now
      });
      return code;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : '招待コードの作成に失敗しました');
      return '';
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function revokeInvite(codeInput: string) {
    if (!user) return false;
    const code = codeInput.trim();
    if (!code || saving) return false;
    setSaving(true);
    setOperationError('');
    setOperationMessage('招待コードを無効化しています...');
    try {
      await updateDoc(doc(db, 'invites', code), { status: 'revoked', updatedAt: new Date().toISOString() });
      return true;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : '招待コードの無効化に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function joinInvite(codeInput: string) {
    if (!user) return false;
    const code = codeInput.trim();
    if (!code) {
      alert('招待コードを入力してください');
      return false;
    }
    setSaving(true);
    setOperationError('');
    setOperationMessage('招待コードを確認しています...');
    const previousGroupId = groupId;
    const previousShareEnabled = shareEnabled;
    const previousActiveSpaceName = activeSpaceName;
    try {
      const inviteRef = doc(db, 'invites', code);
      const inviteSnap = await getDoc(inviteRef);
      const invite = inviteSnap.data();
      if (!inviteSnap.exists() || invite?.status !== 'active' || !invite?.spaceId) throw new Error('招待コードが無効です');
      if (invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now()) throw new Error('招待コードの有効期限が切れています');
      if (invite.maxUses && Number(invite.usedCount || 0) >= Number(invite.maxUses)) throw new Error('招待コードの利用回数上限に達しています');

      const spaceId = String(invite.spaceId);
      const spaceName = String(invite.spaceName || '共有スペース');
      const now = new Date().toISOString();
      await setDoc(doc(db, 'spaces', spaceId, 'members', user.uid), {
        id: user.uid,
        spaceId,
        spaceName,
        userId: user.uid,
        displayName: user.displayName || user.email || '自分',
        role: 'member',
        relationshipLabels: [],
        aliases: [user.displayName || user.email || '自分'],
        joinedAt: now,
        updatedAt: now
      }, { merge: true });
      const nextJoinedSpaceIds = Array.from(new Set([...activeSpaceIds, spaceId, newGroupId(user.uid)].filter(Boolean)));
      await setDoc(doc(db, 'users', user.uid), { groupId: spaceId, activeSpaceId: spaceId, joinedSpaceIds: nextJoinedSpaceIds, shareEnabled: true, updatedAt: now }, { merge: true });
      await updateDoc(inviteRef, { usedCount: increment(1), updatedAt: now });
      setGroupId(spaceId);
      setShareEnabled(true);
      setViewAllSpaces(false);
      setActiveSpaceName(spaceName);
      localStorage.setItem(`groupId_${user.uid}`, spaceId);
      localStorage.setItem(`shareEnabled_${user.uid}`, 'true');
      setSpaces(prev => mergeDocs<SpaceSummary>(prev, [{ id: spaceId, name: spaceName, type: 'group' }]).sort((a, b) => Number(a.type !== 'personal') - Number(b.type !== 'personal') || a.name.localeCompare(b.name, 'ja')));
      await loadAll(user.uid, spaceId);
      await loadJoinedSpaces(user.uid, newGroupId(user.uid), nextJoinedSpaceIds);
      return true;
    } catch (e) {
      setGroupId(previousGroupId);
      setShareEnabled(previousShareEnabled);
      setActiveSpaceName(previousActiveSpaceName);
      setOperationError(e instanceof Error ? e.message : '共有スペースへの参加に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function savePartnerProfile(name: string, relationship: string) {
    if (!user) return;
    const nextName = name.trim();
    const nextRelationship = relationship.trim();
    setPartnerName(nextName);
    setPartnerRelationship(nextRelationship);
    localStorage.setItem(`partnerName_${user.uid}`, nextName);
    localStorage.setItem(`partnerRelationship_${user.uid}`, nextRelationship);
    localStorage.setItem(`partnerProfileConfigured_${user.uid}`, nextName || nextRelationship ? 'true' : 'false');
    try {
      await setDoc(doc(db, 'users', user.uid), { partnerName: nextName, partnerRelationship: nextRelationship, partnerProfileConfigured: Boolean(nextName || nextRelationship), updatedAt: new Date().toISOString() }, { merge: true });
    } catch (e) {
      alert(e instanceof Error ? e.message : '相手情報の保存に失敗しました');
    }
  }

  async function renameSpace(spaceId: string, name: string) {
    if (!user || saving) return false;
    const spaceName = name.trim();
    if (!spaceName) {
      alert('スペース名を入力してください');
      return false;
    }
    const space = spaces.find(item => item.id === spaceId);
    if (!space || space.type === 'personal') return false;
    setSaving(true);
    setOperationError('');
    setOperationMessage('スペース名を更新しています...');
    try {
      await updateDoc(doc(db, 'spaces', spaceId), { name: spaceName, updatedAt: new Date().toISOString() });
      setSpaces(prev => prev.map(item => item.id === spaceId ? { ...item, name: spaceName } : item));
      setSpaceMembers(prev => prev.map(member => member.spaceId === spaceId ? { ...member, spaceName } : member));
      if (groupId === spaceId) setActiveSpaceName(spaceName);
      return true;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'スペース名の更新に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }

  async function leaveSpace(spaceId: string) {
    if (!user || saving) return false;
    const personalId = newGroupId(user.uid);
    if (spaceId === personalId) return false;
    setSaving(true);
    setOperationError('');
    setOperationMessage('スペースから退出しています...');
    try {
      const nextJoinedSpaceIds = activeSpaceIds.filter(id => id !== spaceId);
      await deleteDoc(doc(db, 'spaces', spaceId, 'members', user.uid));
      const nextActiveSpaceId = groupId === spaceId ? personalId : groupId;
      await setDoc(doc(db, 'users', user.uid), { groupId: nextActiveSpaceId, activeSpaceId: nextActiveSpaceId, joinedSpaceIds: Array.from(new Set([personalId, ...nextJoinedSpaceIds].filter(Boolean))), shareEnabled: nextActiveSpaceId !== personalId, updatedAt: new Date().toISOString() }, { merge: true });
      setSpaces(prev => prev.filter(space => space.id !== spaceId));
      setSpaceMembers(prev => prev.filter(member => member.spaceId !== spaceId));
      if (groupId === spaceId) {
        setGroupId(personalId);
        setShareEnabled(false);
        setViewAllSpaces(false);
        setActiveSpaceName(personalSpaceName);
        localStorage.setItem(`groupId_${user.uid}`, personalId);
        localStorage.setItem(`shareEnabled_${user.uid}`, 'false');
        await loadAll(user.uid, personalId);
      }
      return true;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'スペースからの退出に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }

  async function saveMemberProfile(spaceId: string, displayName: string, relationshipsText: string, aliasesText: string) {
    if (!user || saving) return false;
    const space = spaces.find(item => item.id === spaceId);
    if (!space) return false;
    const nextDisplayName = displayName.trim() || user.displayName || user.email || '自分';
    const relationshipLabels = csvToList(relationshipsText);
    const aliases = csvToList(aliasesText);
    setSaving(true);
    setOperationError('');
    setOperationMessage('メンバー情報を保存しています...');
    try {
      await setDoc(doc(db, 'spaces', spaceId, 'members', user.uid), {
        id: user.uid,
        spaceId,
        spaceName: space.name,
        userId: user.uid,
        displayName: nextDisplayName,
        relationshipLabels,
        aliases: aliases.length ? aliases : [nextDisplayName],
        updatedAt: new Date().toISOString()
      }, { merge: true });
      await loadSpaceMembers(spaces);
      return true;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'メンバー情報の保存に失敗しました');
      return false;
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }

  async function enablePushNotifications() {
    if (!user) return;
    try {
      setPushStatus('登録中...');
      const targetSpaceIds = activeSpaceIds.length ? activeSpaceIds : [groupId];
      const token = await enablePwaPush(user.uid, targetSpaceIds);
      setNotificationEnabled(true);
      localStorage.setItem(`notify_${user.uid}`, 'on');
      setPushStatus(`Push登録済み: ${token.slice(0, 12)}... / ${targetSpaceIds.length}スペース`);
      alert('Push通知を有効化しました。参加中スペースのリマインドを受け取れます。iPhoneではホーム画面に追加したアプリから使うと安定します。');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Push通知の登録に失敗しました';
      setPushStatus(msg);
      alert(msg);
    }
  }

  async function enableNotifications(on: boolean) {
    if (on && 'Notification' in window) await Notification.requestPermission();
    setNotificationEnabled(on); localStorage.setItem(`notify_${user!.uid}`, on ? 'on' : 'off');
  }
  function checkReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = Date.now();
    const items = [
      ...todos.filter(t => t.reminderEnabled && t.remindAt && t.status !== 'done').map(t => ({ key: `todo_${t.id}`, title: `ToDo: ${t.title}`, at: t.remindAt! })),
      ...events.filter(e => e.reminderEnabled && e.remindAt).map(e => ({ key: `event_${e.id}`, title: `予定: ${e.title}`, at: e.remindAt! }))
    ];
    for (const item of items) {
      const at = new Date(item.at).getTime();
      if (Math.abs(now - at) < 60000 && localStorage.getItem(`notified_${item.key}`) !== item.at) {
        new Notification(item.title, { body: 'AI Life Diaryのリマインドです。' });
        localStorage.setItem(`notified_${item.key}`, item.at);
      }
    }
  }
  async function saveDoc(type: AddMode, data: Record<string, any>) {
    if (!type || !user) return false;
    if (saving) return false;
    const selectedSpaceId = data.spaceId || groupId;
    const selectedSpace = spaces.find(space => space.id === selectedSpaceId) || ({ id: selectedSpaceId, name: data.spaceName || activeSpaceName || personalSpaceName, type: selectedSpaceId === newGroupId(user.uid) ? 'personal' : 'group' } as SpaceSummary);
    setSaving(true);
    setOperationError('');
    setOperationMessage(editTarget ? '更新しています...' : '保存しています...');
    try {
      const now = new Date().toISOString();
      const target = editTarget?.mode === type ? editTarget : null;
      const existing = target?.data || {};
      const targetSpaceId = data.spaceId || existing.spaceId || existing.groupId || groupId;
      const targetSpaceName = data.spaceName || existing.spaceName || selectedSpace.name || activeSpaceName;
      const base = { userId: user.uid, ownerName: user.displayName || user.email || '自分', ...scopeFieldsForSpace(targetSpaceId, targetSpaceName), visibility: data.visibility || existing.visibility || 'private', aiReadable: data.aiReadable ?? existing.aiReadable ?? true, createdAt: existing.createdAt || now, updatedAt: now };
      let savedId = '';
      let savedPayload: Record<string, any> = {};
      if (type === 'expense') {
        const currency = data.currency as Currency; const amount = Number(data.amount); const rate = ratesToJpy[currency] || 1;
        savedPayload = { ...existing, ...base, ...data, amount, exchangeRate: rate, amountBase: amount * rate, baseCurrency: 'JPY', inputType: data.inputType || existing.inputType || 'manual' };
        if (target) { savedId = target.id; await updateDoc(doc(db, 'expenses', savedId), savedPayload); }
        else { const refDoc = await addDoc(collection(db, 'expenses'), savedPayload); savedId = refDoc.id; }
      } else if (type === 'note') {
        savedPayload = { ...existing, ...scopeFieldsForSpace(targetSpaceId, targetSpaceName), title: data.title, content: data.content, createdBy: user.uid, createdByName: user.displayName || user.email || '自分', createdAt: existing.createdAt || now, updatedAt: now };
        if (target) { savedId = target.id; await updateDoc(doc(db, 'sharedNotes', savedId), savedPayload); }
        else { const refDoc = await addDoc(collection(db, 'sharedNotes'), savedPayload); savedId = refDoc.id; }
      } else {
        const map: Record<string, string> = { diary: 'diaries', event: 'events', todo: 'todos', anniversary: 'anniversaries' };
        savedPayload = { ...existing, ...base, ...data };
        if (target) { savedId = target.id; await updateDoc(doc(db, map[type], savedId), savedPayload); }
        else { const refDoc = await addDoc(collection(db, map[type]), savedPayload); savedId = refDoc.id; }
      }
      try {
        await syncSearchIndex(type, savedId, savedPayload);
      } catch (e) {
        setOperationError(e instanceof Error ? `保存しましたが、${e.message}` : '保存しましたが、AI検索への同期に失敗しました');
      }
      setNaturalDraft(null); setEditTarget(null); setAddMode(null);
      return true;
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : '保存に失敗しました');
      return false;
    } finally { setOperationMessage(''); setSaving(false); }
  }
  async function askAI() {
    if (!user) return;
    if (!question.trim()) return;
    if (saving) return;

    const q = question.trim();
    setQuestion('');
    setChat(c => [...c, { role: 'user', content: q }]);
    setSaving(true);
    setOperationError('');
    setOperationMessage('AIが回答を考えています...');

    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: await authedHeaders(user),
        body: JSON.stringify({
          question: q,
          partnerName,
          partnerRelationship,
          currentUserId: user.uid,
          groupId,
          spaceIds: visibleSpaceIds.length ? visibleSpaceIds : [groupId],
          data: { ...visible, members: spaceMembers },
        }),
      });
      const json = await res.json();
      setChat(c => [...c, { role: 'ai', content: json.answer || '回答を生成できませんでした。' }]);
    } catch {
      setChat(c => [...c, { role: 'ai', content: 'AI回答に失敗しました。OPENAI_API_KEYを確認してください。' }]);
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function naturalAdd(text: string) {
    if (!text.trim()) return;
    if (saving) return;
    setSaving(true);
    setOperationError('');
    setOperationMessage('自然文を解析しています...');
    try {
      const res = await fetch('/api/ai/natural-entry', { method: 'POST', headers: await authedHeaders(user!), body: JSON.stringify({ text }) });
      const json = await res.json();
      if (!res.ok || !json.entry) throw new Error(json.error || '自然文の解析に失敗しました');
      const entry = json.entry || {};
      if (!['event', 'todo', 'expense'].includes(entry.type)) throw new Error('追加できる形式として認識できませんでした');
      const draft = { ...entry, visibility: 'private', aiReadable: true, inputType: entry.type === 'expense' ? 'ai_text' : entry.inputType };
      const draftDate = entry.type === 'event' ? datePart(entry.startAt) : entry.type === 'todo' ? String(entry.dueAt || '').slice(0, 10) : entry.date;
      if (draftDate) {
        setSelectedDate(draftDate);
        setCalendarMonth(draftDate);
      }
      setNaturalDraft(draft);
      setAddMode(entry.type as Exclude<AddMode, null>);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : '自然文追加に失敗しました');
    } finally {
      setOperationMessage('');
      setSaving(false);
    }
  }
  async function repairSearchIndex() {
    if (!user) return;
    if (saving) return;
    setSaving(true);
    setOperationError('');
    setOperationMessage('AI検索を修復しています...');
    try {
      const items = [
        ...visible.diaries.filter((x:any) => x.userId === user.uid).map((x:any) => toRagItem('diary', x.id, x)),
        ...visible.events.filter((x:any) => x.userId === user.uid).map((x:any) => toRagItem('event', x.id, x)),
        ...visible.todos.filter((x:any) => x.userId === user.uid).map((x:any) => toRagItem('todo', x.id, x)),
        ...visible.expenses.filter((x:any) => x.userId === user.uid).map((x:any) => toRagItem('expense', x.id, x)),
        ...visible.anniversaries.filter((x:any) => x.userId === user.uid).map((x:any) => toRagItem('anniversary', x.id, x)),
        ...visible.sharedNotes.filter((x:any) => x.createdBy === user.uid).map((x:any) => toRagItem('note', x.id, x))
      ];
      const res = await fetch('/api/rag/batch', { method: 'POST', headers: await authedHeaders(user), body: JSON.stringify({ items }) });
      const json = await res.json();
      alert(`AI検索の修復が完了しました: ${json.synced || 0}件`);
    } catch (e) {
      setOperationError(e instanceof Error ? e.message : 'AI検索の修復に失敗しました');
    } finally { setOperationMessage(''); setSaving(false); }
  }
}

function Login(p: { name: string; setName: (v: string) => void; email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; login: (r?: boolean) => void; saving: boolean }) {
  return <div className="shell"><main className="content" style={{ paddingTop: 64 }}><div className="card"><h1>AI Life Diary v5</h1><p className="muted">Firebaseログインで開始します。日記・予定・ToDo・支出をAIで横断検索できます。</p><input className="input" placeholder="名前（新規登録時）" value={p.name} onChange={e => p.setName(e.target.value)} /><input className="input" placeholder="メール" value={p.email} onChange={e => p.setEmail(e.target.value)} /><input className="input" type="password" placeholder="パスワード" value={p.password} onChange={e => p.setPassword(e.target.value)} /><div className="grid"><button className="btn" disabled={p.saving} onClick={() => p.login(false)}>ログイン</button><button className="btn secondary" disabled={p.saving} onClick={() => p.login(true)}>新規登録</button></div></div></main></div>;
}

function CalendarHomeView({ selectedDate, setSelectedDate, chooseDate, calendarMonth, setCalendarMonth, diaries, events, todos, expenses, anniversaries, monthExpense, openAdd, onEdit, onDelete, currentUserId, naturalAdd, setTab, saving, spaces, groupId, viewAllSpaces, activeSpaceIds, switchSpace, switchAllSpaces }: any) {
  const [naturalText, setNaturalText] = useState('');
  const [year, month] = calendarMonth.slice(0, 7).split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const blanks = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const cells = [...Array(blanks).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const selectedDiaries = diaries.filter((d: Diary) => d.date === selectedDate).sort((a: Diary, b: Diary) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const selectedEvents = events.filter((e: EventItem) => datePart(e.startAt) === selectedDate).sort((a: EventItem, b: EventItem) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
  const selectedTodos = todos.filter((t: Todo) => (t.dueAt || '').slice(0, 10) === selectedDate).sort((a: Todo, b: Todo) => {
    if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
    const priority = { high: 0, middle: 1, low: 2 } as Record<string, number>;
    return (priority[a.priority] ?? 3) - (priority[b.priority] ?? 3);
  });
  const selectedExpenses = expenses.filter((e: Expense) => e.date === selectedDate).sort((a: Expense, b: Expense) => Number(b.amountBase || 0) - Number(a.amountBase || 0));
  const selectedAnniversaries = anniversaries.filter((a: Anniversary) => a.date?.slice(5) === selectedDate.slice(5)).sort((a: Anniversary, b: Anniversary) => String(a.title || '').localeCompare(String(b.title || '')));
  const selectedTotal = selectedExpenses.reduce((s: number, e: Expense) => s + Number(e.amountBase || 0), 0);
  const openTodoCount = selectedTodos.filter((t: Todo) => t.status !== 'done').length;
  const hasSelectedItems = Boolean(selectedEvents.length || selectedTodos.length || selectedDiaries.length || selectedExpenses.length || selectedAnniversaries.length);
  const hasOnDate = (date: string) => ({
    diary: diaries.some((d: Diary) => d.date === date),
    event: events.some((e: EventItem) => datePart(e.startAt) === date),
    todo: todos.some((t: Todo) => (t.dueAt || '').slice(0, 10) === date && t.status !== 'done'),
    expense: expenses.some((e: Expense) => e.date === date),
    anniversary: anniversaries.some((a: Anniversary) => a.date?.slice(5) === date.slice(5))
  });

  return <><SpaceChatSwitcher spaces={spaces} groupId={groupId} viewAllSpaces={viewAllSpaces} activeSpaceIds={activeSpaceIds} switchSpace={switchSpace} switchAllSpaces={switchAllSpaces} saving={saving} />
    <section className="calendar-hero"><div><p>カレンダー</p><h2>{monthLabel(calendarMonth)}</h2></div><button className="btn secondary" onClick={() => { const today = todayIso(); setSelectedDate(today); setCalendarMonth(today); }}>今日</button></section>
    <section className="calendar-card">
      <div className="calendar-head"><button className="icon-btn" onClick={() => setCalendarMonth(addMonths(calendarMonth, -1))} aria-label="前の月"><ChevronLeft size={18} /></button><b>{monthLabel(calendarMonth)}</b><button className="icon-btn" onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))} aria-label="次の月"><ChevronRight size={18} /></button></div>
      <div className="week-row">{['日', '月', '火', '水', '木', '金', '土'].map(d => <span key={d}>{d}</span>)}</div>
      <div className="month-grid">{cells.map((day, i) => {
        if (!day) return <div key={`blank_${i}`} className="day-cell blank" />;
        const date = dateFromMonthDay(calendarMonth, day);
        const marks = hasOnDate(date);
        return <button key={date} className={`day-cell ${date === selectedDate ? 'selected' : ''} ${date === todayIso() ? 'today' : ''}`} onClick={() => chooseDate(date)}><span>{day}</span><div className="marks">{marks.event && <i className="event" />}{marks.todo && <i className="todo" />}{marks.diary && <i className="diary" />}{marks.expense && <i className="expense" />}{marks.anniversary && <i className="anniv" />}</div></button>;
      })}</div>
    </section>
    <section className="selected-day-panel">
      <div className="row"><div><p className="eyebrow">選択中</p><h3>{new Date(`${selectedDate}T00:00:00+09:00`).toLocaleDateString('ja-JP', { dateStyle: 'full' })}</h3></div><div className="day-total">{yen(selectedTotal)}</div></div>
      <div className="quick date-actions"><button onClick={() => openAdd('diary', selectedDate)}><NotebookPen size={16} />日記</button><button onClick={() => openAdd('todo', selectedDate)}><CheckSquare size={16} />ToDo</button><button onClick={() => openAdd('event', selectedDate)}><CalendarDays size={16} />予定</button><button onClick={() => openAdd('expense', selectedDate)}><ReceiptText size={16} />支出</button></div>
      <div className="day-summary">
        <span><b>{selectedEvents.length}</b>予定</span>
        <span><b>{openTodoCount}</b>未完了</span>
        <span><b>{selectedDiaries.length}</b>日記</span>
        <span><b>{selectedExpenses.length}</b>支出</span>
      </div>
      <div className="day-list">
        {selectedAnniversaries.length > 0 && <div className="day-group"><h4><Gift size={15} />記念日</h4>{selectedAnniversaries.map((a: Anniversary) => <article className="day-item" key={a.id}><div><b>{a.title}</b><ShareBadge item={a} currentUserId={currentUserId} /><span>{a.repeat === 'yearly' ? '毎年' : '一回'}</span></div>{a.userId === currentUserId && <span className="mini-actions"><button className="mini-link" disabled={saving} onClick={() => onEdit('anniversary', a)}>編集</button><button className="mini-link danger-text" disabled={saving} onClick={() => onDelete('anniversary', a.id)}>削除</button></span>}</article>)}</div>}
        {selectedEvents.length > 0 && <div className="day-group"><h4><CalendarDays size={15} />予定</h4>{selectedEvents.map((e: EventItem) => <article className="day-item" key={e.id}><div><b>{e.title}</b><ShareBadge item={e} currentUserId={currentUserId} /><span>{new Date(e.startAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}{e.location ? ` / ${e.location}` : ''}</span></div>{e.userId === currentUserId && <span className="mini-actions"><button className="mini-link" disabled={saving} onClick={() => onEdit('event', e)}>編集</button><button className="mini-link danger-text" disabled={saving} onClick={() => onDelete('event', e.id)}>削除</button></span>}</article>)}</div>}
        {selectedTodos.length > 0 && <div className="day-group"><h4><CheckSquare size={15} />ToDo</h4>{selectedTodos.map((t: Todo) => <article className={`day-item ${t.status === 'done' ? 'is-done' : ''}`} key={t.id}><div><b>{t.title}</b><ShareBadge item={t} currentUserId={currentUserId} /><span>{t.status === 'done' ? '完了' : '未完了'} / 優先度{priorityLabel[t.priority]}</span></div>{t.userId === currentUserId && <span className="mini-actions"><button className="mini-link" disabled={saving} onClick={() => onEdit('todo', t)}>編集</button><button className="mini-link danger-text" disabled={saving} onClick={() => onDelete('todo', t.id)}>削除</button></span>}</article>)}</div>}
        {selectedExpenses.length > 0 && <div className="day-group"><h4><ReceiptText size={15} />支出 <span>{yen(selectedTotal)}</span></h4>{selectedExpenses.map((e: Expense) => <article className="day-item" key={e.id}><div><b>{e.title}</b><ShareBadge item={e} currentUserId={currentUserId} /><span>{categoryLabel[e.category]} / {yen(Number(e.amountBase || 0))}</span></div>{e.userId === currentUserId && <span className="mini-actions"><button className="mini-link" disabled={saving} onClick={() => onEdit('expense', e)}>編集</button><button className="mini-link danger-text" disabled={saving} onClick={() => onDelete('expense', e.id)}>削除</button></span>}</article>)}</div>}
        {selectedDiaries.length > 0 && <div className="day-group"><h4><NotebookPen size={15} />日記</h4>{selectedDiaries.map((d: Diary) => <article className="day-item" key={d.id}><div><b>{d.title}</b><ShareBadge item={d} currentUserId={currentUserId} /><span>{d.mood || d.ownerName}</span></div>{d.userId === currentUserId && <span className="mini-actions"><button className="mini-link" disabled={saving} onClick={() => onEdit('diary', d)}>編集</button><button className="mini-link danger-text" disabled={saving} onClick={() => onDelete('diary', d.id)}>削除</button></span>}</article>)}</div>}
        {!hasSelectedItems && <p className="muted">この日の予定・ToDo・日記はまだありません。</p>}
      </div>
    </section>
    <section className="card natural-card"><h3>自然文で追加</h3><div className="compose"><input className="input" placeholder="例: 明日19時に歯医者 / 今週中に課題提出 / 昨日ランチで1200円" value={naturalText} disabled={saving} onChange={e => setNaturalText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && naturalText.trim() && !saving) { naturalAdd(naturalText); setNaturalText(''); } }} /><button className="btn" disabled={!naturalText.trim() || saving} onClick={() => { naturalAdd(naturalText); setNaturalText(''); }}>{saving ? '処理中...' : '追加'}</button></div></section>
    <div className="grid"><button className="card metric-card" onClick={() => setTab('todo')}><span>未完了ToDo</span><b>{todos.filter((t: Todo) => t.status === 'open').length}</b></button><button className="card metric-card" onClick={() => setTab('expense')}><span>今月の支出</span><b>{yen(monthExpense)}</b></button></div>
  </>;
}

function SpaceChatSwitcher({ spaces, groupId, viewAllSpaces, activeSpaceIds, switchSpace, switchAllSpaces, saving }: any) {
  const spaceOptions = spaces.length ? spaces : [{ id: groupId || '', name: personalSpaceName, type: 'personal' as SpaceType }];
  return <section className="space-chat-panel">
    <div className="space-chat-head"><div><p className="eyebrow">AIの参照先</p><h3>{viewAllSpaces ? 'すべてのスペース' : (spaceOptions.find((space: SpaceSummary) => space.id === groupId)?.name || personalSpaceName)}</h3></div><span>{viewAllSpaces ? `${activeSpaceIds.length || 1}件` : '選択中'}</span></div>
    <div className="space-chat-list">
      <button className={`space-chat-item ${viewAllSpaces ? 'active' : ''}`} disabled={saving || viewAllSpaces} onClick={switchAllSpaces}>
        <span className="space-avatar all"><MessageCircle size={17} /></span>
        <span><b>すべて</b><small>全スペースをまとめて表示</small></span>
      </button>
      {spaceOptions.map((space: SpaceSummary) => {
        const active = !viewAllSpaces && space.id === groupId;
        return <button key={space.id || 'personal'} className={`space-chat-item ${active ? 'active' : ''}`} disabled={saving || active} onClick={() => switchSpace(space)}>
          <span className="space-avatar">{space.name.slice(0, 1) || '自'}</span>
          <span><b>{space.name}</b><small>{space.type === 'personal' ? '個人' : space.type === 'pair' ? '共有相手' : '共有グループ'}</small></span>
        </button>;
      })}
    </div>
  </section>;
}

function DateActionSheet({ selectedDate, close, openAdd }: { selectedDate: string; close: () => void; openAdd: (mode: AddMode, date?: string) => void }) {
  return <div className="date-sheet-backdrop" onClick={close}><div className="date-sheet" onClick={e => e.stopPropagation()}><div className="row"><div><p className="eyebrow">追加先を選択</p><h3>{new Date(`${selectedDate}T00:00:00+09:00`).toLocaleDateString('ja-JP', { dateStyle: 'full' })}</h3></div><button className="icon-btn" onClick={close}>×</button></div><div className="date-sheet-actions"><button onClick={() => openAdd('diary', selectedDate)}><NotebookPen size={18} />日記を書く</button><button onClick={() => openAdd('todo', selectedDate)}><CheckSquare size={18} />ToDoを追加</button><button onClick={() => openAdd('event', selectedDate)}><CalendarDays size={18} />予定を追加</button><button onClick={() => openAdd('expense', selectedDate)}><ReceiptText size={18} />支出を追加</button></div></div></div>;
}

function HomeView({ setAddMode, todayEvents, openTodos, monthExpense, setTab, memoryCards, reminderCards }: any) {
  return <><section className="hero"><p>今日のまとめ</p><h2>{new Date().toLocaleDateString('ja-JP', { dateStyle: 'full' })}</h2><div className="quick"><button onClick={() => setAddMode('diary')}>日記</button><button onClick={() => setAddMode('event')}>予定</button><button onClick={() => setAddMode('todo')}>ToDo</button><button onClick={() => setAddMode('expense')}>支出</button></div></section><div className="grid"><div className="card"><h3>今日の予定</h3>{todayEvents.length ? todayEvents.map((e: EventItem) => <p key={e.id}>・{new Date(e.startAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} {e.title}</p>) : <p className="muted">予定なし</p>}</div><div className="card"><h3>未完了ToDo</h3>{openTodos.slice(0, 5).map((t: Todo) => <p key={t.id}>・{t.title}</p>)}{!openTodos.length && <p className="muted">未完了なし</p>}</div></div><div className="card" onClick={() => setTab('expense')}><h3>今月の支出</h3><div className="big">{yen(monthExpense)}</div><p className="muted">固定レート換算。為替自動取得は除外済み。</p></div><div className="card"><h3>通知センター</h3>{reminderCards.length ? reminderCards.map((m: string, i: number) => <p key={i}>・{m}</p>) : <p className="muted">直近のリマインドはありません。</p>}</div><div className="card"><h3>振り返りカード</h3>{memoryCards.length ? memoryCards.map((m: string, i: number) => <p key={i}>・{m}</p>) : <p className="muted">日記や支出を登録すると表示されます。</p>}</div></>;
}
function DiaryView({ diaries, currentUserId, onEdit, onDelete }: any) { return <Section title="日記">{diaries.map((d: Diary) => <article className="card" key={d.id}><div className="row"><b>{d.title}</b><span>{d.visibility}</span></div><p className="muted">{d.date} / {d.ownerName}</p><p>{d.content}</p>{d.photos?.map(url => <img key={url} className="photo" src={url} alt="diary" />)}{d.userId === currentUserId && <div className="row-actions"><button className="link edit-link" onClick={() => onEdit('diary', d)}>編集</button><button className="link" onClick={() => onDelete('diary', d.id)}>削除</button></div>}</article>)}</Section>; }
function CalendarView({ events, anniversaries, currentUserId, onDelete, setAddMode }: any) { return <Section title="予定・記念日"><div className="grid"><button className="btn" onClick={() => setAddMode('event')}>予定追加</button><button className="btn secondary" onClick={() => setAddMode('anniversary')}>記念日追加</button></div>{events.map((e: EventItem) => <article className="card" key={e.id}><div className="row"><b>{e.title}</b><span>{e.ownerName}</span></div><p className="muted">{new Date(e.startAt).toLocaleString('ja-JP')} {e.location}</p><p>{e.description}</p>{e.remindAt && <p className="muted">リマインド: {new Date(e.remindAt).toLocaleString('ja-JP')}</p>}{e.userId === currentUserId && <button className="link" onClick={() => onDelete('event', e.id)}>削除</button>}</article>)}{anniversaries.map((a: Anniversary) => <article className="card accent" key={a.id}><b>🎁 {a.title}</b><p className="muted">{a.date} / {a.repeat === 'yearly' ? '毎年' : '一回'}</p>{a.userId === currentUserId && <button className="link" onClick={() => onDelete('anniversary', a.id)}>削除</button>}</article>)}</Section>; }
function TodoView({ todos, currentUserId, toggleTodo, onEdit, onDelete }: any) { return <Section title="ToDo">{todos.map((t: Todo) => <article className="card" key={t.id}><label className="row"><span><input type="checkbox" checked={t.status === 'done'} disabled={t.userId !== currentUserId} onChange={() => toggleTodo(t)} /> <b className={t.status === 'done' ? 'done' : ''}>{t.title}</b></span><span>{t.priority}</span></label><p className="muted">期限: {t.dueAt || '-'} / {t.ownerName}</p>{t.remindAt && <p className="muted">リマインド: {new Date(t.remindAt).toLocaleString('ja-JP')}</p>}<p>{t.description}</p>{t.userId === currentUserId && <div className="row-actions"><button className="link edit-link" onClick={() => onEdit('todo', t)}>編集</button><button className="link" onClick={() => onDelete('todo', t.id)}>削除</button></div>}</article>)}</Section>; }
function ExpenseView({ expenses, currentUserId, onEdit, onDelete, setAddMode }: any) { const total = expenses.reduce((s: number, e: Expense) => s + Number(e.amountBase || 0), 0); return <Section title="支出"><button className="btn" onClick={() => setAddMode('expense')}>支出を追加</button><div className="card"><h3>合計</h3><div className="big">{yen(total)}</div></div>{expenses.map((e: Expense) => <article className="card" key={e.id}><div className="row"><b>{e.title}</b><span>{e.amount.toLocaleString()} {e.currency}</span></div><p className="muted">{e.date} / {categoryLabel[e.category]} / {e.ownerName}</p><p>{e.memo}</p>{e.receiptImageUrl && <img className="photo" src={e.receiptImageUrl} alt="receipt" />}{e.userId === currentUserId && <div className="row-actions"><button className="link edit-link" onClick={() => onEdit('expense', e)}>編集</button><button className="link" onClick={() => onDelete('expense', e.id)}>削除</button></div>}</article>)}</Section>; }
function NotesView({ notes, currentUserId, onEdit, onDelete, setAddMode }: any) { return <Section title="共有メモ"><button className="btn" onClick={() => setAddMode('note')}>共有メモ追加</button>{notes.map((n: SharedNote) => <article className="card" key={n.id}><b>{n.title}</b><p className="muted">{n.createdByName}</p><p>{n.content}</p>{n.createdBy === currentUserId && <div className="row-actions"><button className="link edit-link" onClick={() => onEdit('note', n)}>編集</button><button className="link" onClick={() => onDelete('note', n.id)}>削除</button></div>}</article>)}</Section>; }
function AIView({ chat, question, setQuestion, ask, saving }: any) { return <Section title="AIチャット"><div className="chat">{chat.map((m: ChatMessage, i: number) => <div key={i} className={`bubble ${m.role}`}>{m.content}</div>)}</div><div className="compose"><input className="input" placeholder="例: 明後日の予定は？" value={question} disabled={saving} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && !saving && ask()} /><button className="btn" disabled={saving || !question.trim()} onClick={ask}>{saving ? '回答中...' : '質問'}</button></div></Section>; }

function ShareBadge({ item, currentUserId }: { item: { userId?: string; visibility?: Visibility; ownerName?: string }; currentUserId: string }) {
  if (item.userId && item.userId !== currentUserId) return <span className="share-badge partner">{item.ownerName || '相手'}</span>;
  if (item.visibility === 'shared') return <span className="share-badge shared">共有</span>;
  return null;
}

function SettingsView({ user, groupId, shareEnabled, activeSpaceName, spaces, spaceMembers, setGroupId, createSpace, renameSpace, leaveSpace, createInvite, revokeInvite, joinInvite, saveMemberProfile, reload, notificationEnabled, setNotificationEnabled, pushStatus, enablePush, repairSearchIndex, saving, sharedStats }: any) {
  const [joinCode, setJoinCode] = useState('');
  const [inviteDraft, setInviteDraft] = useState('');
  const [inviteSpaceId, setInviteSpaceId] = useState('');
  const [shareMode, setShareMode] = useState<'idle' | 'invite' | 'join'>('idle');
  const [spaceNameDraft, setSpaceNameDraft] = useState('');
  const [spaceNameDrafts, setSpaceNameDrafts] = useState<Record<string, string>>({});
  const [spaceTypeDraft, setSpaceTypeDraft] = useState<SpaceType>('group');
  const [memberDrafts, setMemberDrafts] = useState<Record<string, { displayName: string; relationships: string; aliases: string }>>({});
  const spaceOptions = spaces.length ? spaces : [{ id: newGroupId(user.uid), name: personalSpaceName, type: 'personal' as SpaceType }];
  const shareSpaces = spaceOptions.filter((space: SpaceSummary) => space.type !== 'personal');
  const initialManagedSpaceId = groupId !== newGroupId(user.uid) ? groupId : shareSpaces[0]?.id || spaceOptions[0]?.id || newGroupId(user.uid);
  const [managedSpaceId, setManagedSpaceId] = useState(initialManagedSpaceId);
  useEffect(() => setSpaceNameDrafts(Object.fromEntries((spaces || []).map((space: SpaceSummary) => [space.id, space.name]))), [spaces]);
  useEffect(() => {
    if (!spaceOptions.some((space: SpaceSummary) => space.id === managedSpaceId)) {
      setManagedSpaceId(initialManagedSpaceId);
    }
  }, [initialManagedSpaceId, managedSpaceId, spaceOptions]);
  useEffect(() => {
    if (inviteSpaceId && inviteSpaceId !== managedSpaceId) {
      setInviteDraft('');
      setInviteSpaceId('');
    }
  }, [inviteSpaceId, managedSpaceId]);
  useEffect(() => {
    const mine = (spaceMembers || []).filter((member: MemberProfile) => member.userId === user.uid);
    setMemberDrafts(Object.fromEntries(mine.map((member: MemberProfile) => [member.spaceId, { displayName: member.displayName || '', relationships: listToCsv(member.relationshipLabels), aliases: listToCsv(member.aliases) }])));
  }, [spaceMembers, user.uid]);
  const isSharing = Boolean(shareEnabled && groupId && groupId !== newGroupId(user.uid));
  const managedSpace = (spaceOptions.find((space: SpaceSummary) => space.id === managedSpaceId) || spaceOptions[0]) as SpaceSummary;
  const managedSpaceKey = managedSpace.id;
  const managedSpaceName = managedSpace.name || personalSpaceName;
  const managedMembers = (spaceMembers || []).filter((member: MemberProfile) => member.spaceId === managedSpaceKey);
  const managedMine = managedMembers.find((member: MemberProfile) => member.userId === user.uid);
  const memberDraft = memberDrafts[managedSpaceKey] || { displayName: managedMine?.displayName || '', relationships: listToCsv(managedMine?.relationshipLabels), aliases: listToCsv(managedMine?.aliases) };
  const isManagedPersonal = managedSpace.type === 'personal';
  const copyCode = async () => {
    if (!inviteDraft) return alert('先に招待コードを作成してください');
    await navigator.clipboard?.writeText(inviteDraft);
    alert('招待コードをコピーしました');
  };
  const issueInvite = async () => {
    if (!managedSpace || isManagedPersonal) return alert('招待するグループを選択してください');
    const code = await createInvite(managedSpaceKey);
    if (code) {
      setInviteDraft(code);
      setInviteSpaceId(managedSpaceKey);
    }
  };
  const revokeCurrentInvite = async () => {
    if (!inviteDraft) return;
    const ok = await revokeInvite(inviteDraft);
    if (ok) {
      setInviteDraft('');
      setInviteSpaceId('');
    }
  };
  const joinShare = async () => {
    const ok = await joinInvite(joinCode);
    if (ok) {
      setJoinCode('');
      setShareMode('idle');
    }
  };
  const leaveShare = async () => {
    if (!confirm('個人スペースの表示に戻しますか？共有スペースから退出する場合は「スペース管理」の退出を使ってください。')) return;
    await setGroupId(newGroupId(user.uid));
    setInviteDraft('');
    setInviteSpaceId('');
    setShareMode('idle');
  };
  const showJoin = shareMode === 'join';
  const submitCreateSpace = async () => {
    const createdSpaceId = await createSpace(spaceNameDraft, spaceTypeDraft);
    if (createdSpaceId) {
      setManagedSpaceId(String(createdSpaceId));
      setSpaceNameDraft('');
      setShareMode('idle');
    }
  };
  const updateMemberDraft = (spaceId: string, key: 'displayName' | 'relationships' | 'aliases', value: string) => {
    setMemberDrafts(prev => {
      const draft = prev[spaceId] || { displayName: '', relationships: '', aliases: '' };
      return { ...prev, [spaceId]: { ...draft, [key]: value } };
    });
  };
  const updateSpaceNameDraft = (spaceId: string, value: string) => {
    setSpaceNameDrafts(prev => ({ ...prev, [spaceId]: value }));
  };
  return <Section title="設定">
    <div className="share-status-card">
      <div><p className="eyebrow">AI参照スペース管理</p><h3>{isSharing ? activeSpaceName || '共有スペース' : '個人スペース'}</h3><p className="muted">共有データ {sharedStats.sharedCount}件 / 相手の共有データ {sharedStats.partnerCount}件 / メモ {sharedStats.notesCount}件</p></div>
      <button className="btn secondary" onClick={reload}>再読み込み</button>
    </div>
    <div className="card line-settings-card"><div className="line-card-head"><h3><Users size={18}/> スペース一覧</h3><button className="btn secondary" disabled={saving} onClick={() => setShareMode('invite')}><Share2 size={16}/> 新規作成</button></div><p className="muted">AIチャットbotが参照する個人・共有グループを選びます。表示の切替はホーム画面でできます。</p><div className="line-thread-list">{spaceOptions.map((space: SpaceSummary) => {
      const members = (spaceMembers || []).filter((member: MemberProfile) => member.spaceId === space.id);
      const active = managedSpaceKey === space.id;
      return <button key={space.id} className={`line-thread ${active ? 'active' : ''}`} onClick={() => setManagedSpaceId(space.id)} disabled={saving}><span className="space-avatar">{space.name.slice(0, 1) || '自'}</span><span><b>{space.name}</b><small>{space.type === 'personal' ? '個人' : space.type === 'pair' ? '共有相手' : '共有グループ'} / {Math.max(members.length, space.type === 'personal' ? 1 : members.length)}人</small></span></button>;
    })}</div><button className="btn ghost full" disabled={saving} onClick={() => setShareMode('join')}><Users size={16}/> 招待コードで参加</button></div>

    {shareMode === 'invite' && <div className="card share-card"><h3><Share2 size={18}/> 新しい共有スペースを作成</h3><p className="muted">AIに一緒に参照させたい単位を作成します。例: 家族、友人、旅行、パートナー。</p><input className="input" value={spaceNameDraft} onChange={e => setSpaceNameDraft(e.target.value)} placeholder="スペース名（例: 家族、友人、旅行）" /><select className="select" value={spaceTypeDraft} onChange={e => setSpaceTypeDraft(e.target.value as SpaceType)}><option value="group">共有グループ</option><option value="pair">共有相手</option></select><div className="grid"><button className="btn" disabled={!spaceNameDraft.trim() || saving} onClick={submitCreateSpace}>{saving ? '作成中...' : '作成'}</button><button className="btn secondary" disabled={saving} onClick={() => setShareMode('idle')}>閉じる</button></div></div>}
    {showJoin && <div className="card share-card"><h3><Users size={18}/> 招待コードで参加</h3><p className="muted">相手から受け取った招待コードを入力すると、そのコードに紐づいた共有スペースへ参加します。</p><input className="input code-input" value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="例: PAIR-7K3Q-A9FM" /><div className="grid"><button className="btn" disabled={saving || !joinCode.trim()} onClick={joinShare}>{saving ? '参加中...' : '参加する'}</button><button className="btn secondary" disabled={saving} onClick={() => setShareMode('idle')}>閉じる</button></div></div>}

    <div className="card line-profile-card"><div className="line-profile-head"><span className="space-avatar large">{managedSpaceName.slice(0, 1) || '自'}</span><div><p className="eyebrow">{isManagedPersonal ? '個人' : managedSpace.type === 'pair' ? '共有相手' : '共有グループ'}</p><h3>{managedSpaceName}</h3><p className="muted">{managedMembers.length || (isManagedPersonal ? 1 : 0)}人が参加中</p></div></div>
      <label>スペース名</label><div className="compose"><input className="input" value={spaceNameDrafts[managedSpaceKey] ?? managedSpaceName} disabled={isManagedPersonal || saving} onChange={e => updateSpaceNameDraft(managedSpaceKey, e.target.value)} placeholder="スペース名" /><button className="btn secondary" disabled={isManagedPersonal || saving || (spaceNameDrafts[managedSpaceKey] ?? managedSpaceName).trim() === managedSpaceName} onClick={() => renameSpace(managedSpaceKey, spaceNameDrafts[managedSpaceKey] ?? managedSpaceName)}>保存</button></div>
      {!isManagedPersonal && <div className="invite-target"><span>招待先</span><b>{managedSpaceName}</b></div>}
      {!isManagedPersonal && <div className="invite-box"><label>招待コード</label><input className="input code-input" readOnly value={inviteDraft} placeholder={`${managedSpaceName} の招待コードを未作成`} /><div className="grid"><button className="btn secondary" disabled={saving} onClick={issueInvite}>{saving ? '作成中...' : 'このスペースに招待'}</button><button className="btn secondary" disabled={!inviteDraft} onClick={copyCode}><Copy size={16}/> コピー</button><button className="btn danger" disabled={!inviteDraft || saving} onClick={revokeCurrentInvite}>無効化</button></div></div>}
      <div className="member-list"><h4>メンバー</h4>{managedMembers.length ? managedMembers.map((member: MemberProfile) => <div className="member-row" key={member.userId}><span className="space-avatar">{(member.displayName || member.userId || '?').slice(0, 1)}</span><span><b>{member.displayName || member.userId}</b><small>{[...(member.relationshipLabels || []), ...(member.aliases || [])].slice(0, 4).join(' / ') || '呼び方未設定'}</small></span></div>) : <p className="muted">まだメンバー情報がありません。</p>}</div>
      <div className="alias-editor"><h4>自分の呼び方</h4><p className="muted">AIが「友人Aの予定」「家族の予定」のような質問を理解するための名前です。</p><input className="input" value={memberDraft.displayName} onChange={e => updateMemberDraft(managedSpaceKey, 'displayName', e.target.value)} placeholder="表示名（例: たろう）" /><input className="input" value={memberDraft.relationships} onChange={e => updateMemberDraft(managedSpaceKey, 'relationships', e.target.value)} placeholder="関係性（例: 友人, 家族）" /><input className="input" value={memberDraft.aliases} onChange={e => updateMemberDraft(managedSpaceKey, 'aliases', e.target.value)} placeholder="呼び名（例: 友人A, パパ）" /><button className="btn secondary full" disabled={saving} onClick={() => saveMemberProfile(managedSpaceKey, memberDraft.displayName, memberDraft.relationships, memberDraft.aliases)}>呼び方を保存</button></div>
      {!isManagedPersonal && <button className="btn danger full" disabled={saving} onClick={() => { if (confirm(`${managedSpaceName} から退出しますか？`)) leaveSpace(managedSpaceKey); }}>このスペースから退出</button>}
    </div>
    <div className="card"><h3><Bell size={18}/> 通知</h3><label><input type="checkbox" checked={notificationEnabled} onChange={e => setNotificationEnabled(e.target.checked)} /> アプリ起動中の通知チェックを有効化</label><button className="btn" onClick={enablePush}>PWA Push通知を有効化</button><p className="muted">状態: {pushStatus}</p><p className="muted">iPhoneはSafariで開く → 共有 → ホーム画面に追加 → 追加したアイコンから開いて通知許可、の順に設定してください。</p></div>
    <div className="card"><h3>AI検索</h3><p className="muted">表示対象のAI検索だけを修復します。単一スペース表示中はそのスペースのみ、「すべて」表示中は参加中スペース全体が対象です。</p><button className="btn secondary" disabled={saving} onClick={repairSearchIndex}>{saving ? '修復中...' : '表示対象のAI検索を修復'}</button></div>
    <div className="danger-zone"><button className="btn secondary full" disabled={!isSharing} onClick={leaveShare}>個人スペースに切替</button></div>
    <div className="account-zone"><button className="btn danger full" onClick={() => signOut(auth)}>ログアウト</button><p className="muted">ログイン: {user.email}</p></div>
  </Section>; }
function Section({ title, children }: any) { return <><h2 className="title">{title}</h2>{children}</>; }
function BottomNav({ tab, setTab }: any) { const items = [['home', Home, 'ホーム'], ['ai', MessageCircle, 'AI'], ['notes', StickyNote, 'メモ'], ['settings', Settings, '設定']] as const; return <nav className="bottom compact">{items.map(([key, Icon, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}><Icon size={18} /><span>{label}</span></button>)}</nav>; }

function initialFormFor(mode: AddMode, selectedDate: string, item?: Record<string, any>) {
  const base = { date: selectedDate, startAt: dateTimeOnDate(selectedDate), dueAt: selectedDate, priority: 'middle', status: 'open', currency: 'JPY', category: 'food', visibility: 'private', aiReadable: true, repeat: 'yearly' };
  if (!item) return base;
  if (mode === 'diary') return { ...base, ...item, mood: item.mood || item.tags?.[0] || '' };
  if (mode === 'event') return { ...base, ...item, startAt: toDateTimeLocal(item.startAt), endAt: toDateTimeLocal(item.endAt), remindAt: toDateTimeLocal(item.remindAt), location: locationNameFrom(item) };
  if (mode === 'todo') return { ...base, ...item, remindAt: toDateTimeLocal(item.remindAt) };
  if (mode === 'expense') return { ...base, ...item };
  if (mode === 'anniversary') return { ...base, ...item };
  if (mode === 'note') return { ...base, ...item };
  return { ...base, ...item };
}

function AddModal({ mode, setMode, close, save, user, spaces, activeSpaceId, activeSpaceName, partnerName, selectedDate, editTarget, draftData, saving }: { mode: Exclude<AddMode, null>; setMode: (m: AddMode) => void; close: () => void; save: (m: AddMode, d: any) => void | Promise<unknown>; user: User; spaces: SpaceSummary[]; activeSpaceId: string; activeSpaceName: string; partnerName: string; selectedDate: string; editTarget: EditTarget; draftData: Record<string, any> | null; saving: boolean }) {
  const fallbackSpace = useMemo(() => ({ id: activeSpaceId || newGroupId(user.uid), name: activeSpaceName || personalSpaceName, type: (activeSpaceId === newGroupId(user.uid) ? 'personal' : 'group') as SpaceType }), [activeSpaceId, activeSpaceName, user.uid]);
  const spaceOptions = useMemo(() => spaces.length ? spaces : [fallbackSpace], [spaces, fallbackSpace]);
  const buildInitialForm = useCallback(() => {
    const source = editTarget?.data || draftData || undefined;
    const sourceSpaceId = source?.spaceId || source?.groupId || activeSpaceId || fallbackSpace.id;
    const selectedSpace = spaceOptions.find(space => space.id === sourceSpaceId) || fallbackSpace;
    const initial = initialFormFor(mode, selectedDate, source);
    return { ...initial, visibility: selectedSpace.type === 'personal' ? 'private' : initial.visibility, spaceId: selectedSpace.id, spaceName: source?.spaceName || selectedSpace.name };
  }, [activeSpaceId, draftData, editTarget?.data, fallbackSpace, mode, selectedDate, spaceOptions]);
  const [form, setForm] = useState<Record<string, any>>(buildInitialForm);
  const [receiptBusy, setReceiptBusy] = useState(false); const [aiBusy, setAiBusy] = useState(false); const [aiText, setAiText] = useState('');
  useEffect(() => { setForm(buildInitialForm()); }, [buildInitialForm]);
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  const changeSpace = (spaceId: string) => {
    const next = spaceOptions.find(space => space.id === spaceId) || fallbackSpace;
    setForm(f => ({ ...f, spaceId: next.id, spaceName: next.name, visibility: next.type === 'personal' ? 'private' : f.visibility }));
  };
  async function uploadImage(file: File, folder: string) { const path = `${folder}/${user.uid}/${Date.now()}_${file.name}`; const storageRef = ref(storage, path); await uploadBytes(storageRef, file); return getDownloadURL(storageRef); }
  return <div className="modal"><div className="panel">{!editTarget && !draftData && <div className="tabs"><button className={mode === 'diary' ? 'active' : ''} onClick={() => setMode('diary')}>日記</button><button className={mode === 'event' ? 'active' : ''} onClick={() => setMode('event')}>予定</button><button className={mode === 'todo' ? 'active' : ''} onClick={() => setMode('todo')}>ToDo</button><button className={mode === 'expense' ? 'active' : ''} onClick={() => setMode('expense')}>支出</button><button className={mode === 'anniversary' ? 'active' : ''} onClick={() => setMode('anniversary')}>記念日</button><button className={mode === 'note' ? 'active' : ''} onClick={() => setMode('note')}>メモ</button></div>}<h2 className="title">{editTarget ? '編集' : draftData ? 'AI解析結果を確認' : '追加'}</h2>{draftData && <p className="status-text">AIが作った候補です。日時・金額・種別を確認してから保存してください。</p>}
    {mode === 'diary' && <><input className="input" placeholder="タイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><textarea className="textarea" placeholder="内容" value={form.content || ''} onChange={e => set('content', e.target.value)} /><input className="input" placeholder="気分・タグ" value={form.mood || ''} onChange={e => set('mood', e.target.value)} /><label>写真</label><input className="input" type="file" accept="image/*" multiple onChange={async e => { const files = Array.from(e.target.files || []) as File[]; const urls: string[] = []; for (const file of files) urls.push(await uploadImage(file, 'diaries')); set('photos', urls); }} /></>}
    {mode === 'event' && <><input className="input" placeholder="予定名" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="datetime-local" value={form.startAt || ''} onChange={e => set('startAt', e.target.value)} /><input className="input" type="datetime-local" value={form.endAt || ''} onChange={e => set('endAt', e.target.value)} /><input className="input" placeholder="場所" value={form.location || ''} onChange={e => set('location', e.target.value)} /><textarea className="textarea" placeholder="説明" value={form.description || ''} onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" value={form.remindAt || ''} onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'todo' && <><input className="input" placeholder="ToDo" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.dueAt || selectedDate} onChange={e => set('dueAt', e.target.value)} /><select className="select" value={form.priority} onChange={e => set('priority', e.target.value)}><option value="low">低</option><option value="middle">中</option><option value="high">高</option></select><textarea className="textarea" placeholder="説明" value={form.description || ''} onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" value={form.remindAt || ''} onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'expense' && <><div className="card" style={{ boxShadow: 'none' }}><h3>AI自然文入力</h3><input className="input" placeholder="例: 昨日Grabで35リンギット使った" value={aiText} disabled={aiBusy || saving} onChange={e => setAiText(e.target.value)} /><button className="btn secondary" disabled={!aiText.trim() || aiBusy || saving} onClick={async () => { setAiBusy(true); try { const res = await fetch('/api/ai/natural-entry', { method: 'POST', headers: await authedHeaders(user), body: JSON.stringify({ text: aiText }) }); const json = await res.json(); if (!res.ok || !json.entry) throw new Error(json.error || 'AI入力に失敗しました'); setForm(f => ({ ...f, ...json.entry, inputType: 'ai_text' })); } catch (err) { alert(err instanceof Error ? err.message : 'AI入力に失敗しました'); } finally { setAiBusy(false); } }}>{aiBusy ? '解析中...' : 'AIで入力'}</button></div><label>レシート写真</label><input className="input" type="file" accept="image/*" disabled={receiptBusy || saving} onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setReceiptBusy(true); try { const url = await uploadImage(file, 'receipts'); const res = await fetch('/api/ai/receipt', { method: 'POST', headers: await authedHeaders(user), body: JSON.stringify({ imageUrl: url }) }); const json = await res.json(); if (!res.ok || !json.expense) throw new Error(json.error || 'レシート解析に失敗しました'); setForm(f => ({ ...f, ...json.expense, receiptImageUrl: url, inputType: 'receipt' })); } catch (err) { alert(err instanceof Error ? err.message : 'レシート解析に失敗しました'); } finally { setReceiptBusy(false); } }} />{receiptBusy && <p className="muted">レシート解析中...</p>}<input className="input" placeholder="タイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><input className="input" type="number" placeholder="金額" value={form.amount || ''} onChange={e => set('amount', e.target.value)} /><select className="select" value={form.currency} onChange={e => set('currency', e.target.value)}><option value="JPY">JPY</option><option value="MYR">MYR</option><option value="USD">USD</option></select><select className="select" value={form.category} onChange={e => set('category', e.target.value)}>{categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select><input className="input" placeholder="店名" value={form.shopName || ''} onChange={e => set('shopName', e.target.value)} /><textarea className="textarea" placeholder="メモ" value={form.memo || ''} onChange={e => set('memo', e.target.value)} /></>}
    {mode === 'anniversary' && <><input className="input" placeholder="記念日名" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><select className="select" value={form.repeat} onChange={e => set('repeat', e.target.value)}><option value="yearly">毎年</option><option value="none">一回だけ</option></select></>}
    {mode === 'note' && <><input className="input" placeholder="メモタイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><textarea className="textarea" placeholder="共有メモ内容" value={form.content || ''} onChange={e => set('content', e.target.value)} /></>}
    <div className="space-select-box"><label>保存先スペース</label><select className="select" value={form.spaceId || activeSpaceId} onChange={e => changeSpace(e.target.value)}>{spaceOptions.map(space => <option key={space.id} value={space.id}>{space.name}（{space.type === 'personal' ? '自分' : space.type === 'pair' ? '1対1' : 'グループ'}）</option>)}</select></div>
    {mode !== 'note' && <><select className="select" value={form.visibility} onChange={e => set('visibility', e.target.value)} disabled={(spaceOptions.find(space => space.id === form.spaceId)?.type || fallbackSpace.type) === 'personal'}><option value="private">自分だけ</option><option value="shared">共有</option></select><label><input type="checkbox" checked={form.aiReadable} onChange={e => set('aiReadable', e.target.checked)} /> AI参照を許可</label></>}<div className="grid" style={{ marginTop: 14 }}><button className="btn secondary" disabled={saving} onClick={close}>閉じる</button><button className="btn" disabled={saving || receiptBusy || aiBusy} onClick={() => save(mode, normalize(mode, form))}>{saving ? '処理中...' : editTarget ? '更新' : '保存'}</button></div><p className="muted">保存先スペースと共有設定に応じて、AIが参照できる範囲が変わります。相手の呼び名: {partnerName || '未設定'}</p></div></div>;
}
function normalize(mode: AddMode, f: Record<string, any>) { if (mode === 'diary') { const { location, locationName, lat, lng, ...diary } = f; return { ...diary, tags: f.mood ? [f.mood] : [] }; } if (mode === 'event') return { ...f, startAt: new Date(f.startAt).toISOString(), endAt: f.endAt ? new Date(f.endAt).toISOString() : '', remindAt: f.remindAt ? new Date(f.remindAt).toISOString() : '' }; if (mode === 'expense') return { ...f, amount: Number(f.amount || 0), title: f.title || '支出', date: f.date || todayIso(), category: f.category || 'other', currency: f.currency || 'JPY' }; if (mode === 'todo') return { ...f, status: f.status || 'open', priority: f.priority || 'middle', remindAt: f.remindAt ? new Date(f.remindAt).toISOString() : '' }; return f; }

function buildReminderCards(todos: Todo[], events: EventItem[], anniversaries: Anniversary[]) {
  const now = Date.now();
  const limit = now + 1000 * 60 * 60 * 24 * 14;
  const cards: string[] = [];
  todos.filter(t => t.status !== 'done' && (t.remindAt || t.dueAt)).forEach(t => {
    const at = new Date(t.remindAt || `${t.dueAt}T09:00:00`).getTime();
    if (!Number.isNaN(at) && at >= now && at <= limit) cards.push(`ToDo「${t.title}」${new Date(at).toLocaleString('ja-JP')}まで`);
  });
  events.filter(e => e.remindAt || e.startAt).forEach(e => {
    const at = new Date(e.remindAt || e.startAt).getTime();
    if (!Number.isNaN(at) && at >= now && at <= limit) cards.push(`予定「${e.title}」${new Date(at).toLocaleString('ja-JP')}`);
  });
  const mmddNow = todayIso().slice(5);
  anniversaries.forEach(a => {
    if (a.repeat === 'yearly' && a.date?.slice(5) >= mmddNow) cards.push(`記念日「${a.title}」${a.date.slice(5)}`);
  });
  return cards.slice(0, 6);
}
function buildMemoryCards(diaries: Diary[], expenses: Expense[], events: EventItem[], anniversaries: Anniversary[]) { const today = todayIso(); const todayMmdd = today.slice(5); const cards: string[] = []; const lastYear = diaries.find(d => d.date?.slice(5) === todayMmdd); if (lastYear) cards.push(`過去の今日: ${lastYear.title}`); const month = today.slice(0, 7); const monthDiary = diaries.filter(d => d.date?.startsWith(month)); if (monthDiary.length) cards.push(`今月の日記は${monthDiary.length}件あります`); const monthExpense = expenses.filter(e => e.date?.startsWith(month)).reduce((s, e) => s + Number(e.amountBase || 0), 0); if (monthExpense) cards.push(`今月の支出は${yen(monthExpense)}です`); const upcomingAnniv = anniversaries.map(a => ({ item: a, mmdd: a.date?.slice(5) || '' })).filter(a => a.mmdd).sort((a, b) => Number(a.mmdd < todayMmdd) - Number(b.mmdd < todayMmdd) || a.mmdd.localeCompare(b.mmdd))[0]?.item; if (upcomingAnniv) cards.push(`次の記念日: ${upcomingAnniv.title}（${upcomingAnniv.date}）`); return cards.slice(0, 4); }
