'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db, storage } from '@/lib/firebase';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Bell, CalendarDays, CheckSquare, ChevronLeft, ChevronRight, Gift, Home, MessageCircle, NotebookPen, ReceiptText, Settings, StickyNote, Users, Copy, Share2 } from 'lucide-react';
import { todayIso, toDateTimeLocalValue } from '@/lib/date';
import { enablePwaPush } from '@/lib/push';
import type { Anniversary, Currency, Diary, EventItem, Expense, ExpenseCategory, SharedNote, Todo, Visibility } from '@/types/app';

type Tab = 'home' | 'diary' | 'calendar' | 'todo' | 'expense' | 'ai' | 'notes' | 'settings';
type AddMode = 'diary' | 'event' | 'todo' | 'expense' | 'anniversary' | 'note' | null;
type ChatMessage = { role: 'user' | 'ai'; content: string };
type EditTarget = { mode: Exclude<AddMode, null>; id: string; data: Record<string, any> } | null;

const categories: { value: ExpenseCategory; label: string }[] = [
  { value: 'food', label: '食費' }, { value: 'daily_goods', label: '日用品' }, { value: 'dating', label: '交際費' }, { value: 'transport', label: '交通費' }, { value: 'travel', label: '旅行' }, { value: 'medical', label: '医療費' }, { value: 'entertainment', label: '娯楽' }, { value: 'other', label: 'その他' }
];
const categoryLabel = Object.fromEntries(categories.map(c => [c.value, c.label]));
const priorityLabel = { high: '高', middle: '中', low: '低' };
const ratesToJpy: Record<Currency, number> = { JPY: 1, MYR: 33, USD: 155 }; // 自動取得は設計から除外。設定値として固定。
const newGroupId = (uid: string) => `group_${uid}`;
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

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    try {
      setUser(u);
      if (u) {
        const userRef = doc(db, 'users', u.uid);
        const userSnap = await getDoc(userRef);
        const savedGroupId = userSnap.data()?.groupId;
        const cachedGroupId = localStorage.getItem(`groupId_${u.uid}`);
        const gid = savedGroupId || cachedGroupId || newGroupId(u.uid);
        const savedPartnerName = userSnap.data()?.partnerName;
        const savedPartnerRelationship = userSnap.data()?.partnerRelationship;
        const savedPartnerProfileConfigured = userSnap.data()?.partnerProfileConfigured;
        const cachedPartnerProfileConfigured = localStorage.getItem(`partnerProfileConfigured_${u.uid}`);
        setGroupId(gid);
        localStorage.setItem(`groupId_${u.uid}`, gid);
        const nextPartnerName = partnerFieldValue(savedPartnerName || localStorage.getItem(`partnerName_${u.uid}`), savedPartnerProfileConfigured || cachedPartnerProfileConfigured);
        const nextPartnerRelationship = partnerFieldValue(savedPartnerRelationship || localStorage.getItem(`partnerRelationship_${u.uid}`), savedPartnerProfileConfigured || cachedPartnerProfileConfigured);
        setPartnerName(nextPartnerName);
        setPartnerRelationship(nextPartnerRelationship);
        setNotificationEnabled(localStorage.getItem(`notify_${u.uid}`) === 'on');
        await setDoc(userRef, { name: u.displayName || u.email || 'User', email: u.email, defaultCurrency: 'JPY', groupId: gid, partnerName: nextPartnerName, partnerRelationship: nextPartnerRelationship, partnerProfileConfigured: Boolean(nextPartnerName || nextPartnerRelationship), updatedAt: new Date().toISOString() }, { merge: true });
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
    if (!uid || !groupId) return;
    setLoadError('');

    const byDesc = (key: string) => (a: any, b: any) => String(b[key] || '').localeCompare(String(a[key] || ''));
    const byAsc = (key: string) => (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || ''));
    const handleSyncError = (e: unknown) => setLoadError(e instanceof Error ? e.message : '共有データの自動同期に失敗しました');
    const subscribeScoped = <T extends { id: string }>(col: string, setItems: (items: T[]) => void, sortItems: (a: T, b: T) => number) => {
      let own: T[] = [];
      let shared: T[] = [];
      let ownLoaded = false;
      let sharedLoaded = false;
      const publish = () => {
        if (!ownLoaded || !sharedLoaded) return;
        setItems(mergeDocs(own, shared).sort(sortItems));
      };
      const ownUnsub = onSnapshot(
        query(collection(db, col), where('userId', '==', uid), where('groupId', '==', groupId)),
        snap => { own = snap.docs.map(v => ({ id: v.id, ...v.data() } as T)); ownLoaded = true; publish(); },
        handleSyncError
      );
      const sharedUnsub = onSnapshot(
        query(collection(db, col), where('groupId', '==', groupId), where('visibility', '==', 'shared')),
        snap => { shared = snap.docs.map(v => ({ id: v.id, ...v.data() } as T)); sharedLoaded = true; publish(); },
        handleSyncError
      );
      return () => { ownUnsub(); sharedUnsub(); };
    };

    const unsubs = [
      subscribeScoped<Diary>('diaries', setDiaries, byDesc('date')),
      subscribeScoped<EventItem>('events', setEvents, byAsc('startAt')),
      subscribeScoped<Todo>('todos', setTodos, byDesc('createdAt')),
      subscribeScoped<Expense>('expenses', setExpenses, byDesc('date')),
      subscribeScoped<Anniversary>('anniversaries', setAnniversaries, byAsc('date')),
      onSnapshot(
        query(collection(db, 'sharedNotes'), where('groupId', '==', groupId)),
        snap => setSharedNotes(snap.docs.map(v => ({ id: v.id, ...v.data() } as SharedNote)).sort(byDesc('createdAt'))),
        handleSyncError
      )
    ];

    return () => unsubs.forEach(unsub => unsub());
  }, [user?.uid, groupId]);

  async function loadAll(uid = user?.uid, gid = groupId) {
    if (!uid || !gid) return;
    setDataLoading(true);
    setLoadError('');
    try {
      const readScoped = async <T extends { id: string }>(col: string) => {
        const [own, shared] = await Promise.all([
          getDocs(query(collection(db, col), where('userId', '==', uid), where('groupId', '==', gid))),
          getDocs(query(collection(db, col), where('groupId', '==', gid), where('visibility', '==', 'shared')))
        ]);
        return mergeDocs(
          own.docs.map(v => ({ id: v.id, ...v.data() } as T)),
          shared.docs.map(v => ({ id: v.id, ...v.data() } as T))
        );
      };
      const [d, e, t, x, a, n] = await Promise.all([
        readScoped<Diary>('diaries'),
        readScoped<EventItem>('events'),
        readScoped<Todo>('todos'),
        readScoped<Expense>('expenses'),
        readScoped<Anniversary>('anniversaries'),
        getDocs(query(collection(db, 'sharedNotes'), where('groupId', '==', gid)))
      ]);
      const byDesc = (key: string) => (a: any, b: any) => String(b[key] || '').localeCompare(String(a[key] || ''));
      const byAsc = (key: string) => (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || ''));
      setDiaries(d.sort(byDesc('date')));
      setEvents(e.sort(byAsc('startAt')));
      setTodos(t.sort(byDesc('createdAt')));
      setExpenses(x.sort(byDesc('date')));
      setAnniversaries(a.sort(byAsc('date')));
      setSharedNotes(n.docs.map(v => ({ id: v.id, ...v.data() } as SharedNote)).sort(byDesc('createdAt')));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'データの読み込みに失敗しました');
    } finally {
      setDataLoading(false);
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
      {loadError && <div className="error-card"><div><b>データを読み込めませんでした</b><p>{loadError}</p></div><button className="btn secondary" disabled={dataLoading} onClick={() => loadAll(user.uid, groupId)}>{dataLoading ? '再読み込み中...' : '再読み込み'}</button></div>}
      {operationError && <div className="error-card"><div><b>操作に失敗しました</b><p>{operationError}</p></div><button className="btn secondary" onClick={() => setOperationError('')}>閉じる</button></div>}
      {operationMessage && <div className="sync-status">{operationMessage}</div>}
      {dataLoading && !loadError && <div className="sync-status">データを更新しています...</div>}
      {tab === 'home' && <CalendarHomeView selectedDate={selectedDate} setSelectedDate={setSelectedDate} chooseDate={chooseDate} calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth} diaries={diaries} events={events} todos={todos} expenses={expenses} anniversaries={anniversaries} monthExpense={monthExpense} openAdd={openAddForDate} onEdit={openEdit} onDelete={remove} currentUserId={user.uid} naturalAdd={naturalAdd} setTab={setTab} saving={saving} />}
      {tab === 'diary' && <DiaryView diaries={diaries} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} />}
      {tab === 'calendar' && <CalendarHomeView selectedDate={selectedDate} setSelectedDate={setSelectedDate} chooseDate={chooseDate} calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth} diaries={diaries} events={events} todos={todos} expenses={expenses} anniversaries={anniversaries} monthExpense={monthExpense} openAdd={openAddForDate} onEdit={openEdit} onDelete={remove} currentUserId={user.uid} naturalAdd={naturalAdd} setTab={setTab} saving={saving} />}
      {tab === 'todo' && <TodoView todos={todos} currentUserId={user.uid} toggleTodo={toggleTodo} onEdit={openEdit} onDelete={remove} />}
      {tab === 'expense' && <ExpenseView expenses={expenses} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'ai' && <AIView chat={chat} question={question} setQuestion={setQuestion} ask={askAI} saving={saving} />}
      {tab === 'notes' && <NotesView notes={sharedNotes} currentUserId={user.uid} onEdit={openEdit} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'settings' && <SettingsView user={user} groupId={groupId} setGroupId={saveGroupId} partnerName={partnerName} partnerRelationship={partnerRelationship} savePartnerProfile={savePartnerProfile} reload={() => loadAll()} notificationEnabled={notificationEnabled} setNotificationEnabled={enableNotifications} pushStatus={pushStatus} enablePush={enablePushNotifications} repairSearchIndex={repairSearchIndex} saving={saving} sharedStats={sharedStats} />}
    </main>
    <BottomNav tab={tab} setTab={setTab} />
    {datePickerOpen && <DateActionSheet selectedDate={selectedDate} close={() => setDatePickerOpen(false)} openAdd={openAddForDate} />}
    {addMode && <AddModal mode={addMode} setMode={setAddMode} close={() => { setNaturalDraft(null); setEditTarget(null); setAddMode(null); }} save={saveDoc} user={user} groupId={groupId} partnerName={partnerName} selectedDate={selectedDate} editTarget={editTarget} draftData={naturalDraft} saving={saving} />}
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
    setGroupId(nextGroupId);
    try {
      await setDoc(doc(db, 'users', user.uid), { groupId: nextGroupId, updatedAt: new Date().toISOString() }, { merge: true });
      localStorage.setItem(`groupId_${user.uid}`, nextGroupId);
      await loadAll(user.uid, nextGroupId);
    } catch (e) {
      setGroupId(previousGroupId);
      alert(e instanceof Error ? e.message : '共有IDの保存に失敗しました');
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

  async function enablePushNotifications() {
    if (!user) return;
    try {
      setPushStatus('登録中...');
      const token = await enablePwaPush(user.uid, groupId);
      setNotificationEnabled(true);
      localStorage.setItem(`notify_${user.uid}`, 'on');
      setPushStatus(`Push登録済み: ${token.slice(0, 12)}...`);
      alert('Push通知を有効化しました。iPhoneではホーム画面に追加したアプリから使うと安定します。');
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
    setSaving(true);
    setOperationError('');
    setOperationMessage(editTarget ? '更新しています...' : '保存しています...');
    try {
      const now = new Date().toISOString();
      const target = editTarget?.mode === type ? editTarget : null;
      const existing = target?.data || {};
      const base = { userId: user.uid, ownerName: user.displayName || user.email || '自分', groupId, visibility: data.visibility || existing.visibility || 'private', aiReadable: data.aiReadable ?? existing.aiReadable ?? true, createdAt: existing.createdAt || now, updatedAt: now };
      let savedId = '';
      let savedPayload: Record<string, any> = {};
      if (type === 'expense') {
        const currency = data.currency as Currency; const amount = Number(data.amount); const rate = ratesToJpy[currency] || 1;
        savedPayload = { ...existing, ...base, ...data, amount, exchangeRate: rate, amountBase: amount * rate, baseCurrency: 'JPY', inputType: data.inputType || existing.inputType || 'manual' };
        if (target) { savedId = target.id; await updateDoc(doc(db, 'expenses', savedId), savedPayload); }
        else { const refDoc = await addDoc(collection(db, 'expenses'), savedPayload); savedId = refDoc.id; }
      } else if (type === 'note') {
        savedPayload = { ...existing, groupId, title: data.title, content: data.content, createdBy: user.uid, createdByName: user.displayName || user.email || '自分', createdAt: existing.createdAt || now, updatedAt: now };
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
          data: visible,
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

function CalendarHomeView({ selectedDate, setSelectedDate, chooseDate, calendarMonth, setCalendarMonth, diaries, events, todos, expenses, anniversaries, monthExpense, openAdd, onEdit, onDelete, currentUserId, naturalAdd, setTab, saving }: any) {
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

  return <><section className="calendar-hero"><div><p>カレンダー</p><h2>{monthLabel(calendarMonth)}</h2></div><button className="btn secondary" onClick={() => { const today = todayIso(); setSelectedDate(today); setCalendarMonth(today); }}>今日</button></section>
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

function SettingsView({ user, groupId, setGroupId, partnerName, partnerRelationship, savePartnerProfile, reload, notificationEnabled, setNotificationEnabled, pushStatus, enablePush, repairSearchIndex, saving, sharedStats }: any) {
  const [joinCode, setJoinCode] = useState('');
  const [shareMode, setShareMode] = useState<'idle' | 'invite' | 'join'>('idle');
  const [partnerNameDraft, setPartnerNameDraft] = useState(partnerName);
  const [partnerRelationshipDraft, setPartnerRelationshipDraft] = useState(partnerRelationship);
  useEffect(() => setPartnerNameDraft(partnerName), [partnerName]);
  useEffect(() => setPartnerRelationshipDraft(partnerRelationship), [partnerRelationship]);
  const createInvite = () => {
    setShareMode('invite');
    setGroupId(inviteCode());
  };
  const isSharing = Boolean(groupId && groupId !== newGroupId(user.uid));
  const displayInviteCode = isSharing ? groupId : '';
  const copyCode = async () => {
    if (!displayInviteCode) return alert('先に招待コードを作成してください');
    await navigator.clipboard?.writeText(displayInviteCode);
    alert('招待コードをコピーしました');
  };
  const joinShare = () => {
    const code = joinCode.trim();
    if (!code) return alert('招待コードを入力してください');
    setGroupId(code);
    setShareMode('idle');
  };
  const leaveShare = () => {
    if (!confirm('共有を解除しますか？自分のデータは消えませんが、相手の共有データは表示されなくなります。')) return;
    setGroupId(newGroupId(user.uid));
    setShareMode('idle');
  };
  const showInvite = isSharing || shareMode === 'invite';
  const showJoin = !isSharing && shareMode === 'join';
  return <Section title="設定">
    <div className="share-status-card">
      <div><p className="eyebrow">共有状態</p><h3>{isSharing ? `共有中: ${partnerName || '未設定'}（${partnerRelationship || '相手'}）` : '未共有'}</h3><p className="muted">共有データ {sharedStats.sharedCount}件 / 相手の共有データ {sharedStats.partnerCount}件 / メモ {sharedStats.notesCount}件</p></div>
      <button className="btn secondary" onClick={reload}>再読み込み</button>
    </div>
    {!isSharing && shareMode === 'idle' && <div className="card share-card share-start-card"><h3><Users size={18}/> 共有をはじめる</h3><p className="muted">初期状態は共有なしです。共有したい時だけ、招待コードを作成するか、相手から受け取ったコードで参加します。</p><div className="share-choice-grid"><button className="btn" onClick={createInvite}><Share2 size={16}/> 招待する</button><button className="btn secondary" onClick={() => setShareMode('join')}><Users size={16}/> 参加する</button></div></div>}
    {showInvite && <div className="card share-card"><h3><Share2 size={18}/> 相手を招待する</h3><p className="muted">このコードを相手に送ると、同じ共有スペースに参加できます。</p><label>招待コード</label><input className="input code-input" readOnly value={displayInviteCode} placeholder="未共有" /><div className="grid"><button className="btn secondary" onClick={createInvite}><Share2 size={16}/> 新しいコードを作成</button><button className="btn secondary" disabled={!displayInviteCode} onClick={copyCode}><Copy size={16}/> コピー</button></div>{!isSharing && <button className="link edit-link" onClick={() => setShareMode('idle')}>戻る</button>}</div>}
    {showJoin && <div className="card share-card"><h3><Users size={18}/> 招待コードで参加する</h3><p className="muted">相手から受け取った招待コードを入力します。入力後、共有データを再読み込みします。</p><input className="input code-input" value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="例: PAIR-7K3Q-A9FM" /><div className="grid"><button className="btn" onClick={joinShare}>参加する</button><button className="btn secondary" onClick={() => setShareMode('idle')}>戻る</button></div></div>}
    <div className="card share-card"><h3>相手情報</h3><p className="muted">AIへの質問で使う名前と関係性です。例: 「さきの予定」「家族の支出」</p><input className="input" value={partnerNameDraft} onChange={e => setPartnerNameDraft(e.target.value)} placeholder="相手の名前（例: さき）" /><input className="input" value={partnerRelationshipDraft} onChange={e => setPartnerRelationshipDraft(e.target.value)} placeholder="関係性（例: 家族、友人、パートナー）" /><button className="btn secondary" onClick={() => savePartnerProfile(partnerNameDraft, partnerRelationshipDraft)}>相手情報を保存</button></div>
    <div className="card"><h3><Bell size={18}/> 通知</h3><label><input type="checkbox" checked={notificationEnabled} onChange={e => setNotificationEnabled(e.target.checked)} /> アプリ起動中の通知チェックを有効化</label><button className="btn" onClick={enablePush}>PWA Push通知を有効化</button><p className="muted">状態: {pushStatus}</p><p className="muted">iPhoneはSafariで開く → 共有 → ホーム画面に追加 → 追加したアイコンから開いて通知許可、の順に設定してください。</p></div>
    <div className="card"><h3>AI検索</h3><p className="muted">AIの検索結果が古い、または登録した内容が見つからない時だけ修復してください。</p><button className="btn secondary" disabled={saving} onClick={repairSearchIndex}>{saving ? '修復中...' : 'AI検索を修復'}</button></div>
    <div className="danger-zone"><button className="btn danger full" disabled={!isSharing} onClick={leaveShare}>共有を解除</button></div>
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

function AddModal({ mode, setMode, close, save, user, partnerName, selectedDate, editTarget, draftData, saving }: { mode: AddMode; setMode: (m: AddMode) => void; close: () => void; save: (m: AddMode, d: any) => void | Promise<unknown>; user: User; groupId: string; partnerName: string; selectedDate: string; editTarget: EditTarget; draftData: Record<string, any> | null; saving: boolean }) {
  const [form, setForm] = useState<Record<string, any>>(() => initialFormFor(mode, selectedDate, editTarget?.data || draftData || undefined));
  const [receiptBusy, setReceiptBusy] = useState(false); const [aiBusy, setAiBusy] = useState(false); const [aiText, setAiText] = useState('');
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  async function uploadImage(file: File, folder: string) { const path = `${folder}/${user.uid}/${Date.now()}_${file.name}`; const storageRef = ref(storage, path); await uploadBytes(storageRef, file); return getDownloadURL(storageRef); }
  return <div className="modal"><div className="panel">{!editTarget && !draftData && <div className="tabs"><button className={mode === 'diary' ? 'active' : ''} onClick={() => setMode('diary')}>日記</button><button className={mode === 'event' ? 'active' : ''} onClick={() => setMode('event')}>予定</button><button className={mode === 'todo' ? 'active' : ''} onClick={() => setMode('todo')}>ToDo</button><button className={mode === 'expense' ? 'active' : ''} onClick={() => setMode('expense')}>支出</button><button className={mode === 'anniversary' ? 'active' : ''} onClick={() => setMode('anniversary')}>記念日</button><button className={mode === 'note' ? 'active' : ''} onClick={() => setMode('note')}>メモ</button></div>}<h2 className="title">{editTarget ? '編集' : draftData ? 'AI解析結果を確認' : '追加'}</h2>{draftData && <p className="status-text">AIが作った候補です。日時・金額・種別を確認してから保存してください。</p>}
    {mode === 'diary' && <><input className="input" placeholder="タイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><textarea className="textarea" placeholder="内容" value={form.content || ''} onChange={e => set('content', e.target.value)} /><input className="input" placeholder="気分・タグ" value={form.mood || ''} onChange={e => set('mood', e.target.value)} /><label>写真</label><input className="input" type="file" accept="image/*" multiple onChange={async e => { const files = Array.from(e.target.files || []) as File[]; const urls: string[] = []; for (const file of files) urls.push(await uploadImage(file, 'diaries')); set('photos', urls); }} /></>}
    {mode === 'event' && <><input className="input" placeholder="予定名" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="datetime-local" value={form.startAt || ''} onChange={e => set('startAt', e.target.value)} /><input className="input" type="datetime-local" value={form.endAt || ''} onChange={e => set('endAt', e.target.value)} /><input className="input" placeholder="場所" value={form.location || ''} onChange={e => set('location', e.target.value)} /><textarea className="textarea" placeholder="説明" value={form.description || ''} onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" value={form.remindAt || ''} onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'todo' && <><input className="input" placeholder="ToDo" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.dueAt || selectedDate} onChange={e => set('dueAt', e.target.value)} /><select className="select" value={form.priority} onChange={e => set('priority', e.target.value)}><option value="low">低</option><option value="middle">中</option><option value="high">高</option></select><textarea className="textarea" placeholder="説明" value={form.description || ''} onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" value={form.remindAt || ''} onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'expense' && <><div className="card" style={{ boxShadow: 'none' }}><h3>AI自然文入力</h3><input className="input" placeholder="例: 昨日Grabで35リンギット使った" value={aiText} disabled={aiBusy || saving} onChange={e => setAiText(e.target.value)} /><button className="btn secondary" disabled={!aiText.trim() || aiBusy || saving} onClick={async () => { setAiBusy(true); try { const res = await fetch('/api/ai/natural-entry', { method: 'POST', headers: await authedHeaders(user), body: JSON.stringify({ text: aiText }) }); const json = await res.json(); if (!res.ok || !json.entry) throw new Error(json.error || 'AI入力に失敗しました'); setForm(f => ({ ...f, ...json.entry, inputType: 'ai_text' })); } catch (err) { alert(err instanceof Error ? err.message : 'AI入力に失敗しました'); } finally { setAiBusy(false); } }}>{aiBusy ? '解析中...' : 'AIで入力'}</button></div><label>レシート写真</label><input className="input" type="file" accept="image/*" disabled={receiptBusy || saving} onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setReceiptBusy(true); try { const url = await uploadImage(file, 'receipts'); const res = await fetch('/api/ai/receipt', { method: 'POST', headers: await authedHeaders(user), body: JSON.stringify({ imageUrl: url }) }); const json = await res.json(); if (!res.ok || !json.expense) throw new Error(json.error || 'レシート解析に失敗しました'); setForm(f => ({ ...f, ...json.expense, receiptImageUrl: url, inputType: 'receipt' })); } catch (err) { alert(err instanceof Error ? err.message : 'レシート解析に失敗しました'); } finally { setReceiptBusy(false); } }} />{receiptBusy && <p className="muted">レシート解析中...</p>}<input className="input" placeholder="タイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><input className="input" type="number" placeholder="金額" value={form.amount || ''} onChange={e => set('amount', e.target.value)} /><select className="select" value={form.currency} onChange={e => set('currency', e.target.value)}><option value="JPY">JPY</option><option value="MYR">MYR</option><option value="USD">USD</option></select><select className="select" value={form.category} onChange={e => set('category', e.target.value)}>{categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select><input className="input" placeholder="店名" value={form.shopName || ''} onChange={e => set('shopName', e.target.value)} /><textarea className="textarea" placeholder="メモ" value={form.memo || ''} onChange={e => set('memo', e.target.value)} /></>}
    {mode === 'anniversary' && <><input className="input" placeholder="記念日名" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><select className="select" value={form.repeat} onChange={e => set('repeat', e.target.value)}><option value="yearly">毎年</option><option value="none">一回だけ</option></select></>}
    {mode === 'note' && <><input className="input" placeholder="メモタイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><textarea className="textarea" placeholder="共有メモ内容" value={form.content || ''} onChange={e => set('content', e.target.value)} /></>}
    {mode !== 'note' && <><select className="select" value={form.visibility} onChange={e => set('visibility', e.target.value)}><option value="private">自分だけ</option><option value="shared">共有</option></select><label><input type="checkbox" checked={form.aiReadable} onChange={e => set('aiReadable', e.target.checked)} /> AI参照を許可</label></>}<div className="grid" style={{ marginTop: 14 }}><button className="btn secondary" disabled={saving} onClick={close}>閉じる</button><button className="btn" disabled={saving || receiptBusy || aiBusy} onClick={() => save(mode, normalize(mode, form))}>{saving ? '処理中...' : editTarget ? '更新' : '保存'}</button></div><p className="muted">共有設定にすると、同じ共有IDの相手がAIで参照できます。相手の呼び名: {partnerName || '未設定'}</p></div></div>;
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
