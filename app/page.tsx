'use client';

import { useEffect, useMemo, useState } from 'react';
import { auth, db, storage } from '@/lib/firebase';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signOut, updateProfile, type User } from 'firebase/auth';
import { addDoc, collection, deleteDoc, doc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { Bell, CalendarDays, CheckSquare, Gift, Home, MessageCircle, NotebookPen, ReceiptText, Settings, StickyNote, Users, Copy, Share2 } from 'lucide-react';
import { todayIso, toDateTimeLocalValue } from '@/lib/date';
import { enablePwaPush } from '@/lib/push';
import type { Anniversary, Currency, Diary, EventItem, Expense, ExpenseCategory, SharedNote, Todo, Visibility } from '@/types/app';

type Tab = 'home' | 'diary' | 'calendar' | 'todo' | 'expense' | 'ai' | 'notes' | 'settings';
type AddMode = 'diary' | 'event' | 'todo' | 'expense' | 'anniversary' | 'note' | null;
type ChatMessage = { role: 'user' | 'ai'; content: string };

const categories: { value: ExpenseCategory; label: string }[] = [
  { value: 'food', label: '食費' }, { value: 'daily_goods', label: '日用品' }, { value: 'dating', label: '交際費' }, { value: 'transport', label: '交通費' }, { value: 'travel', label: '旅行' }, { value: 'medical', label: '医療費' }, { value: 'entertainment', label: '娯楽' }, { value: 'other', label: 'その他' }
];
const categoryLabel = Object.fromEntries(categories.map(c => [c.value, c.label]));
const ratesToJpy: Record<Currency, number> = { JPY: 1, MYR: 33, USD: 155 }; // 自動取得は設計から除外。設定値として固定。
const newGroupId = (uid: string) => `group_${uid}`;
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;
const datePart = (s?: string) => (s || '').slice(0, 10);

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
  const content = [item.content, item.description, item.memo, item.location?.name, item.shopName].filter(Boolean).join('\n');
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
  const [partnerName, setPartnerName] = useState('彼女');
  const [diaries, setDiaries] = useState<Diary[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([]);
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([{ role: 'ai', content: '日記・予定・ToDo・支出・記念日・共有メモを横断検索できます。例:「彼女の明後日の予定は？」「今週の課題は？」「先週いくら使った？」' }]);
  const [question, setQuestion] = useState('');
  const [saving, setSaving] = useState(false);
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [pushStatus, setPushStatus] = useState('未設定');

  useEffect(() => onAuthStateChanged(auth, async (u) => {
    setUser(u);
    if (u) {
      const gid = localStorage.getItem(`groupId_${u.uid}`) || newGroupId(u.uid);
      setGroupId(gid);
      setPartnerName(localStorage.getItem(`partnerName_${u.uid}`) || '彼女');
      setNotificationEnabled(localStorage.getItem(`notify_${u.uid}`) === 'on');
      await setDoc(doc(db, 'users', u.uid), { name: u.displayName || u.email || 'User', email: u.email, defaultCurrency: 'JPY', groupId: gid, updatedAt: new Date().toISOString() }, { merge: true });
      await loadAll(u.uid, gid);
    }
    setLoading(false);
  }), []);

  useEffect(() => {
    if (!user || !notificationEnabled) return;
    const id = setInterval(() => checkReminders(), 60000);
    checkReminders();
    return () => clearInterval(id);
  }, [user, notificationEnabled, todos, events, anniversaries]);

  async function loadAll(uid = user?.uid, gid = groupId) {
    if (!uid || !gid) return;
    const [d, e, t, x, a, n] = await Promise.all([
      getDocs(query(collection(db, 'diaries'), where('groupId', '==', gid))),
      getDocs(query(collection(db, 'events'), where('groupId', '==', gid))),
      getDocs(query(collection(db, 'todos'), where('groupId', '==', gid))),
      getDocs(query(collection(db, 'expenses'), where('groupId', '==', gid))),
      getDocs(query(collection(db, 'anniversaries'), where('groupId', '==', gid))),
      getDocs(query(collection(db, 'sharedNotes'), where('groupId', '==', gid)))
    ]);
    const byDesc = (key: string) => (a: any, b: any) => String(b[key] || '').localeCompare(String(a[key] || ''));
    const byAsc = (key: string) => (a: any, b: any) => String(a[key] || '').localeCompare(String(b[key] || ''));
    setDiaries(d.docs.map(v => ({ id: v.id, ...v.data() } as Diary)).sort(byDesc('date')));
    setEvents(e.docs.map(v => ({ id: v.id, ...v.data() } as EventItem)).sort(byAsc('startAt')));
    setTodos(t.docs.map(v => ({ id: v.id, ...v.data() } as Todo)).sort(byDesc('createdAt')));
    setExpenses(x.docs.map(v => ({ id: v.id, ...v.data() } as Expense)).sort(byDesc('date')));
    setAnniversaries(a.docs.map(v => ({ id: v.id, ...v.data() } as Anniversary)).sort(byAsc('date')));
    setSharedNotes(n.docs.map(v => ({ id: v.id, ...v.data() } as SharedNote)).sort(byDesc('createdAt')));
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
  const openTodos = todos.filter(t => t.status === 'open');
  const todayEvents = events.filter(e => datePart(e.startAt) === todayIso());
  const memoryCards = buildMemoryCards(diaries, expenses, events, anniversaries);
  const reminderCards = buildReminderCards(todos, events, anniversaries);

  if (loading) return <div className="shell"><main className="content"><div className="card">読み込み中...</div></main></div>;
  if (!user) return <Login name={name} setName={setName} email={email} setEmail={setEmail} password={password} setPassword={setPassword} login={login} saving={saving} />;

  return <div className="shell">
    <header className="top"><div className="brand"><div><h1>AI Life Diary v5</h1><p>第4版：iPhone PWA Push通知・FCM・リマインド送信の土台を追加</p></div><div className="avatar">{(user.displayName || user.email || 'U').slice(0, 1).toUpperCase()}</div></div></header>
    <main className="content">
      {tab === 'home' && <HomeView setAddMode={setAddMode} todayEvents={todayEvents} openTodos={openTodos} monthExpense={monthExpense} setTab={setTab} memoryCards={memoryCards} reminderCards={reminderCards} />}
      {tab === 'diary' && <DiaryView diaries={diaries} onDelete={remove} />}
      {tab === 'calendar' && <CalendarView events={events} anniversaries={anniversaries} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'todo' && <TodoView todos={todos} toggleTodo={toggleTodo} onDelete={remove} />}
      {tab === 'expense' && <ExpenseView expenses={expenses} setAddMode={setAddMode} />}
      {tab === 'ai' && <AIView chat={chat} question={question} setQuestion={setQuestion} ask={askAI} saving={saving} naturalAdd={naturalAdd} rebuildRagIndex={rebuildRagIndex} />}
      {tab === 'notes' && <NotesView notes={sharedNotes} onDelete={remove} setAddMode={setAddMode} />}
      {tab === 'settings' && <SettingsView user={user} groupId={groupId} setGroupId={saveGroupId} partnerName={partnerName} setPartnerName={savePartnerName} reload={() => loadAll()} notificationEnabled={notificationEnabled} setNotificationEnabled={enableNotifications} pushStatus={pushStatus} enablePush={enablePushNotifications} />}
    </main>
    <button className="fab" onClick={() => setAddMode('diary')}>＋</button>
    <BottomNav tab={tab} setTab={setTab} />
    {addMode && <AddModal mode={addMode} setMode={setAddMode} save={saveDoc} user={user} groupId={groupId} partnerName={partnerName} />}
  </div>;

  async function remove(type: string, id: string) {
    if (!confirm('削除しますか？')) return;
    const map: Record<string, string> = { diary: 'diaries', event: 'events', todo: 'todos', expense: 'expenses', anniversary: 'anniversaries', note: 'sharedNotes' };
    await deleteDoc(doc(db, map[type], id));
    fetch('/api/rag/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: type === 'note' ? 'sharedNote' : type, id }) }).catch(() => undefined);
    await loadAll();
  }
  async function toggleTodo(todo: Todo) { await updateDoc(doc(db, 'todos', todo.id), { status: todo.status === 'done' ? 'open' : 'done', updatedAt: new Date().toISOString() }); await loadAll(); }
  function saveGroupId(v: string) { setGroupId(v); localStorage.setItem(`groupId_${user!.uid}`, v); }
  function savePartnerName(v: string) { setPartnerName(v); localStorage.setItem(`partnerName_${user!.uid}`, v); }

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
    if (!type || !user) return;
    setSaving(true);
    try {
      const base = { userId: user.uid, ownerName: user.displayName || user.email || '自分', groupId, visibility: data.visibility || 'private', aiReadable: data.aiReadable ?? true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      let savedId = '';
      let savedPayload: Record<string, any> = {};
      if (type === 'expense') {
        const currency = data.currency as Currency; const amount = Number(data.amount); const rate = ratesToJpy[currency] || 1;
        savedPayload = { ...base, ...data, amount, exchangeRate: rate, amountBase: amount * rate, baseCurrency: 'JPY', inputType: data.inputType || 'manual' };
        const refDoc = await addDoc(collection(db, 'expenses'), savedPayload);
        savedId = refDoc.id;
      } else if (type === 'note') {
        savedPayload = { groupId, title: data.title, content: data.content, createdBy: user.uid, createdByName: user.displayName || user.email || '自分', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const refDoc = await addDoc(collection(db, 'sharedNotes'), savedPayload);
        savedId = refDoc.id;
      } else {
        const map: Record<string, string> = { diary: 'diaries', event: 'events', todo: 'todos', anniversary: 'anniversaries' };
        savedPayload = { ...base, ...data };
        const refDoc = await addDoc(collection(db, map[type]), savedPayload);
        savedId = refDoc.id;
      }
      fetch('/api/rag/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toRagItem(type, savedId, savedPayload)) }).catch(() => undefined);
      setAddMode(null); await loadAll();
    } catch (e) { alert(e instanceof Error ? e.message : '保存に失敗しました'); }
    finally { setSaving(false); }
  }
  async function askAI() {
    if (!user) return;
    if (!question.trim()) return;

    const q = question.trim();
    setQuestion('');
    setChat(c => [...c, { role: 'user', content: q }]);
    setSaving(true);

    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          partnerName,
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
      setSaving(false);
    }
  }
  async function naturalAdd(text: string) {
    if (!text.trim()) return;
    const res = await fetch('/api/ai/natural-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const json = await res.json();
    const entry = json.entry || {};
    if (entry.type === 'event') await saveDoc('event', normalize('event', { ...entry, visibility: 'private', aiReadable: true }));
    if (entry.type === 'todo') await saveDoc('todo', normalize('todo', { ...entry, visibility: 'private', aiReadable: true }));
    if (entry.type === 'expense') await saveDoc('expense', normalize('expense', { ...entry, visibility: 'private', aiReadable: true, inputType: 'ai_text' }));
    setChat(c => [...c, { role: 'ai', content: `自然文から${entry.type === 'todo' ? 'ToDo' : entry.type === 'expense' ? '支出' : '予定'}を追加しました。` }]);
  }
  async function rebuildRagIndex() {
    if (!user) return;
    setSaving(true);
    try {
      const items = [
        ...visible.diaries.map((x:any) => toRagItem('diary', x.id, x)),
        ...visible.events.map((x:any) => toRagItem('event', x.id, x)),
        ...visible.todos.map((x:any) => toRagItem('todo', x.id, x)),
        ...visible.expenses.map((x:any) => toRagItem('expense', x.id, x)),
        ...visible.anniversaries.map((x:any) => toRagItem('anniversary', x.id, x)),
        ...visible.sharedNotes.map((x:any) => toRagItem('note', x.id, x))
      ];
      const res = await fetch('/api/rag/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
      const json = await res.json();
      alert(`RAG再同期完了: ${json.synced || 0}件`);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'RAG再同期に失敗しました');
    } finally { setSaving(false); }
  }
}

function Login(p: { name: string; setName: (v: string) => void; email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; login: (r?: boolean) => void; saving: boolean }) {
  return <div className="shell"><main className="content" style={{ paddingTop: 64 }}><div className="card"><h1>AI Life Diary v5</h1><p className="muted">Firebaseログインで開始します。第5版ではEmbeddingを使った本格RAG検索を追加しています。</p><input className="input" placeholder="名前（新規登録時）" value={p.name} onChange={e => p.setName(e.target.value)} /><input className="input" placeholder="メール" value={p.email} onChange={e => p.setEmail(e.target.value)} /><input className="input" type="password" placeholder="パスワード" value={p.password} onChange={e => p.setPassword(e.target.value)} /><div className="grid"><button className="btn" disabled={p.saving} onClick={() => p.login(false)}>ログイン</button><button className="btn secondary" disabled={p.saving} onClick={() => p.login(true)}>新規登録</button></div></div></main></div>;
}

function HomeView({ setAddMode, todayEvents, openTodos, monthExpense, setTab, memoryCards, reminderCards }: any) {
  return <><section className="hero"><p>今日のまとめ</p><h2>{new Date().toLocaleDateString('ja-JP', { dateStyle: 'full' })}</h2><div className="quick"><button onClick={() => setAddMode('diary')}>日記</button><button onClick={() => setAddMode('event')}>予定</button><button onClick={() => setAddMode('todo')}>ToDo</button><button onClick={() => setAddMode('expense')}>支出</button></div></section><div className="grid"><div className="card"><h3>今日の予定</h3>{todayEvents.length ? todayEvents.map((e: EventItem) => <p key={e.id}>・{new Date(e.startAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} {e.title}</p>) : <p className="muted">予定なし</p>}</div><div className="card"><h3>未完了ToDo</h3>{openTodos.slice(0, 5).map((t: Todo) => <p key={t.id}>・{t.title}</p>)}{!openTodos.length && <p className="muted">未完了なし</p>}</div></div><div className="card" onClick={() => setTab('expense')}><h3>今月の支出</h3><div className="big">{yen(monthExpense)}</div><p className="muted">固定レート換算。為替自動取得は除外済み。</p></div><div className="card"><h3>通知センター</h3>{reminderCards.length ? reminderCards.map((m: string, i: number) => <p key={i}>・{m}</p>) : <p className="muted">直近のリマインドはありません。</p>}</div><div className="card"><h3>振り返りカード</h3>{memoryCards.length ? memoryCards.map((m: string, i: number) => <p key={i}>・{m}</p>) : <p className="muted">日記や支出を登録すると表示されます。</p>}</div></>;
}
function DiaryView({ diaries, onDelete }: any) { return <Section title="日記">{diaries.map((d: Diary) => <article className="card" key={d.id}><div className="row"><b>{d.title}</b><span>{d.visibility}</span></div><p className="muted">{d.date} / {d.ownerName}</p><p>{d.content}</p>{d.location?.name && <p className="muted">場所: {d.location.name}</p>}{d.photos?.map(url => <img key={url} className="photo" src={url} alt="diary" />)}<button className="link" onClick={() => onDelete('diary', d.id)}>削除</button></article>)}</Section>; }
function CalendarView({ events, anniversaries, onDelete, setAddMode }: any) { return <Section title="予定・記念日"><div className="grid"><button className="btn" onClick={() => setAddMode('event')}>予定追加</button><button className="btn secondary" onClick={() => setAddMode('anniversary')}>記念日追加</button></div>{events.map((e: EventItem) => <article className="card" key={e.id}><div className="row"><b>{e.title}</b><span>{e.ownerName}</span></div><p className="muted">{new Date(e.startAt).toLocaleString('ja-JP')} {e.location}</p><p>{e.description}</p>{e.remindAt && <p className="muted">リマインド: {new Date(e.remindAt).toLocaleString('ja-JP')}</p>}<button className="link" onClick={() => onDelete('event', e.id)}>削除</button></article>)}{anniversaries.map((a: Anniversary) => <article className="card accent" key={a.id}><b>🎁 {a.title}</b><p className="muted">{a.date} / {a.repeat === 'yearly' ? '毎年' : '一回'}</p><button className="link" onClick={() => onDelete('anniversary', a.id)}>削除</button></article>)}</Section>; }
function TodoView({ todos, toggleTodo, onDelete }: any) { return <Section title="ToDo">{todos.map((t: Todo) => <article className="card" key={t.id}><label className="row"><span><input type="checkbox" checked={t.status === 'done'} onChange={() => toggleTodo(t)} /> <b className={t.status === 'done' ? 'done' : ''}>{t.title}</b></span><span>{t.priority}</span></label><p className="muted">期限: {t.dueAt || '-'} / {t.ownerName}</p>{t.remindAt && <p className="muted">リマインド: {new Date(t.remindAt).toLocaleString('ja-JP')}</p>}<p>{t.description}</p><button className="link" onClick={() => onDelete('todo', t.id)}>削除</button></article>)}</Section>; }
function ExpenseView({ expenses, setAddMode }: any) { const total = expenses.reduce((s: number, e: Expense) => s + Number(e.amountBase || 0), 0); return <Section title="支出"><button className="btn" onClick={() => setAddMode('expense')}>支出を追加</button><div className="card"><h3>合計</h3><div className="big">{yen(total)}</div></div>{expenses.map((e: Expense) => <article className="card" key={e.id}><div className="row"><b>{e.title}</b><span>{e.amount.toLocaleString()} {e.currency}</span></div><p className="muted">{e.date} / {categoryLabel[e.category]} / {e.ownerName}</p><p>{e.memo}</p>{e.receiptImageUrl && <img className="photo" src={e.receiptImageUrl} alt="receipt" />}</article>)}</Section>; }
function NotesView({ notes, onDelete, setAddMode }: any) { return <Section title="共有メモ"><button className="btn" onClick={() => setAddMode('note')}>共有メモ追加</button>{notes.map((n: SharedNote) => <article className="card" key={n.id}><b>{n.title}</b><p className="muted">{n.createdByName}</p><p>{n.content}</p><button className="link" onClick={() => onDelete('note', n.id)}>削除</button></article>)}</Section>; }
function AIView({ chat, question, setQuestion, ask, saving, naturalAdd, rebuildRagIndex }: any) { const [text, setText] = useState(''); return <Section title="AI"><div className="chat">{chat.map((m: ChatMessage, i: number) => <div key={i} className={`bubble ${m.role}`}>{m.content}</div>)}</div><div className="compose"><input className="input" placeholder="例: 彼女の明後日の予定は？" value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask()} /><button className="btn" disabled={saving} onClick={ask}>質問</button></div><div className="card"><h3>自然文で追加</h3><input className="input" placeholder="例: 明日19時に歯医者 / 今週中に課題提出 / 昨日ランチで1200円" value={text} onChange={e => setText(e.target.value)} /><button className="btn secondary" onClick={() => { naturalAdd(text); setText(''); }}>予定・ToDo・支出に追加</button></div><div className="card"><h3>RAG意味検索</h3><p className="muted">日記本文・メモ・予定・ToDo・支出をEmbedding化して、曖昧な質問にも答えやすくします。既存データを登録した後は一度だけ再同期してください。</p><button className="btn secondary" disabled={saving} onClick={rebuildRagIndex}>RAGインデックスを再同期</button></div></Section>; }
function SettingsView({ user, groupId, setGroupId, partnerName, setPartnerName, reload, notificationEnabled, setNotificationEnabled, pushStatus, enablePush }: any) {
  const generateCode = () => `couple_${Math.random().toString(36).slice(2, 8)}_${user.uid.slice(0, 4)}`;
  const copyCode = async () => { await navigator.clipboard?.writeText(groupId); alert('共有IDをコピーしました'); };
  return <Section title="設定"><div className="card"><h3><Users size={18}/> カップル共有</h3><p className="muted">同じ共有IDを2人で設定すると、sharedにした予定・ToDo・日記・支出・メモを共有できます。</p><input className="input" value={groupId} onChange={e => setGroupId(e.target.value)} /><div className="grid"><button className="btn secondary" onClick={() => setGroupId(generateCode())}><Share2 size={16}/> 招待コードを作成</button><button className="btn secondary" onClick={copyCode}><Copy size={16}/> コピー</button></div><input className="input" value={partnerName} onChange={e => setPartnerName(e.target.value)} placeholder="相手の呼び名（例: 彼女）" /><button className="btn secondary" onClick={reload}>共有データを再読み込み</button><p className="muted">使い方: 片方が招待コードを作成 → コピーして相手に送る → 相手が同じ共有IDに設定。</p></div><div className="card"><h3><Bell size={18}/> 通知</h3><label><input type="checkbox" checked={notificationEnabled} onChange={e => setNotificationEnabled(e.target.checked)} /> アプリ起動中の通知チェックを有効化</label><button className="btn" onClick={enablePush}>PWA Push通知を有効化</button><p className="muted">状態: {pushStatus}</p><p className="muted">iPhoneはSafariで開く → 共有 → ホーム画面に追加 → 追加したアイコンから開いて通知許可、の順に設定してください。</p></div><button className="btn danger" onClick={() => signOut(auth)}>ログアウト</button><p className="muted">ログイン: {user.email}</p></Section>; }
function Section({ title, children }: any) { return <><h2 className="title">{title}</h2>{children}</>; }
function BottomNav({ tab, setTab }: any) { const items = [['home', Home, 'ホーム'], ['diary', NotebookPen, '日記'], ['calendar', CalendarDays, '予定'], ['todo', CheckSquare, 'ToDo'], ['expense', ReceiptText, '支出'], ['ai', MessageCircle, 'AI'], ['notes', StickyNote, 'メモ'], ['settings', Settings, '設定']] as const; return <nav className="bottom">{items.map(([key, Icon, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}><Icon size={18} /><span>{label}</span></button>)}</nav>; }

function AddModal({ mode, setMode, save, user, partnerName }: { mode: AddMode; setMode: (m: AddMode) => void; save: (m: AddMode, d: any) => void; user: User; groupId: string; partnerName: string }) {
  const [form, setForm] = useState<Record<string, any>>({ date: todayIso(), startAt: toDateTimeLocalValue(new Date()), priority: 'middle', status: 'open', currency: 'JPY', category: 'food', visibility: 'private', aiReadable: true, repeat: 'yearly' });
  const [receiptBusy, setReceiptBusy] = useState(false); const [aiText, setAiText] = useState('');
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));
  async function uploadImage(file: File, folder: string) { const path = `${folder}/${user.uid}/${Date.now()}_${file.name}`; const storageRef = ref(storage, path); await uploadBytes(storageRef, file); return getDownloadURL(storageRef); }
  return <div className="modal"><div className="panel"><div className="tabs"><button className={mode === 'diary' ? 'active' : ''} onClick={() => setMode('diary')}>日記</button><button className={mode === 'event' ? 'active' : ''} onClick={() => setMode('event')}>予定</button><button className={mode === 'todo' ? 'active' : ''} onClick={() => setMode('todo')}>ToDo</button><button className={mode === 'expense' ? 'active' : ''} onClick={() => setMode('expense')}>支出</button><button className={mode === 'anniversary' ? 'active' : ''} onClick={() => setMode('anniversary')}>記念日</button><button className={mode === 'note' ? 'active' : ''} onClick={() => setMode('note')}>メモ</button></div><h2 className="title">追加</h2>
    {mode === 'diary' && <><input className="input" placeholder="タイトル" onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><textarea className="textarea" placeholder="内容" onChange={e => set('content', e.target.value)} /><input className="input" placeholder="気分・タグ" onChange={e => set('mood', e.target.value)} /><input className="input" placeholder="場所名" onChange={e => set('locationName', e.target.value)} /><button className="btn secondary" onClick={() => navigator.geolocation?.getCurrentPosition(pos => setForm(f => ({ ...f, lat: pos.coords.latitude, lng: pos.coords.longitude })))}>現在地をセット</button><label>写真</label><input className="input" type="file" accept="image/*" multiple onChange={async e => { const files = Array.from(e.target.files || []) as File[]; const urls: string[] = []; for (const file of files) urls.push(await uploadImage(file, 'diaries')); set('photos', urls); }} /></>}
    {mode === 'event' && <><input className="input" placeholder="予定名" onChange={e => set('title', e.target.value)} /><input className="input" type="datetime-local" value={form.startAt} onChange={e => set('startAt', e.target.value)} /><input className="input" type="datetime-local" onChange={e => set('endAt', e.target.value)} /><input className="input" placeholder="場所" onChange={e => set('location', e.target.value)} /><textarea className="textarea" placeholder="説明" onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'todo' && <><input className="input" placeholder="ToDo" onChange={e => set('title', e.target.value)} /><input className="input" type="date" onChange={e => set('dueAt', e.target.value)} /><select className="select" value={form.priority} onChange={e => set('priority', e.target.value)}><option value="low">低</option><option value="middle">中</option><option value="high">高</option></select><textarea className="textarea" placeholder="説明" onChange={e => set('description', e.target.value)} /><label><input type="checkbox" checked={!!form.reminderEnabled} onChange={e => set('reminderEnabled', e.target.checked)} /> リマインド</label><input className="input" type="datetime-local" onChange={e => set('remindAt', e.target.value)} /></>}
    {mode === 'expense' && <><div className="card" style={{ boxShadow: 'none' }}><h3>AI自然文入力</h3><input className="input" placeholder="例: 昨日Grabで35リンギット使った" value={aiText} onChange={e => setAiText(e.target.value)} /><button className="btn secondary" onClick={async () => { const res = await fetch('/api/ai/natural-entry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: aiText }) }); const json = await res.json(); setForm(f => ({ ...f, ...json.entry, inputType: 'ai_text' })); }}>AIで入力</button></div><label>レシート写真</label><input className="input" type="file" accept="image/*" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; setReceiptBusy(true); const url = await uploadImage(file, 'receipts'); const res = await fetch('/api/ai/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: url }) }); const json = await res.json(); setForm(f => ({ ...f, ...json.expense, receiptImageUrl: url, inputType: 'receipt' })); setReceiptBusy(false); }} />{receiptBusy && <p className="muted">レシート解析中...</p>}<input className="input" placeholder="タイトル" value={form.title || ''} onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><input className="input" type="number" placeholder="金額" value={form.amount || ''} onChange={e => set('amount', e.target.value)} /><select className="select" value={form.currency} onChange={e => set('currency', e.target.value)}><option value="JPY">JPY</option><option value="MYR">MYR</option><option value="USD">USD</option></select><select className="select" value={form.category} onChange={e => set('category', e.target.value)}>{categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select><input className="input" placeholder="店名" value={form.shopName || ''} onChange={e => set('shopName', e.target.value)} /><textarea className="textarea" placeholder="メモ" value={form.memo || ''} onChange={e => set('memo', e.target.value)} /></>}
    {mode === 'anniversary' && <><input className="input" placeholder="記念日名" onChange={e => set('title', e.target.value)} /><input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} /><select className="select" value={form.repeat} onChange={e => set('repeat', e.target.value)}><option value="yearly">毎年</option><option value="none">一回だけ</option></select></>}
    {mode === 'note' && <><input className="input" placeholder="メモタイトル" onChange={e => set('title', e.target.value)} /><textarea className="textarea" placeholder="共有メモ内容" onChange={e => set('content', e.target.value)} /></>}
    {mode !== 'note' && <><select className="select" value={form.visibility} onChange={e => set('visibility', e.target.value)}><option value="private">自分だけ</option><option value="shared">共有</option></select><label><input type="checkbox" checked={form.aiReadable} onChange={e => set('aiReadable', e.target.checked)} /> AI参照を許可</label></>}<div className="grid" style={{ marginTop: 14 }}><button className="btn secondary" onClick={() => setMode(null)}>閉じる</button><button className="btn" onClick={() => save(mode, normalize(mode, form))}>保存</button></div><p className="muted">共有設定にすると、同じ共有IDの相手がAIで参照できます。相手の呼び名: {partnerName}</p></div></div>;
}
function normalize(mode: AddMode, f: Record<string, any>) { if (mode === 'diary') return { ...f, tags: f.mood ? [f.mood] : [], location: { name: f.locationName || '', lat: f.lat, lng: f.lng } }; if (mode === 'event') return { ...f, startAt: new Date(f.startAt).toISOString(), endAt: f.endAt ? new Date(f.endAt).toISOString() : '', remindAt: f.remindAt ? new Date(f.remindAt).toISOString() : '' }; if (mode === 'expense') return { ...f, amount: Number(f.amount || 0), title: f.title || '支出', date: f.date || todayIso(), category: f.category || 'other', currency: f.currency || 'JPY' }; if (mode === 'todo') return { ...f, status: f.status || 'open', priority: f.priority || 'middle', remindAt: f.remindAt ? new Date(f.remindAt).toISOString() : '' }; return f; }

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
function buildMemoryCards(diaries: Diary[], expenses: Expense[], events: EventItem[], anniversaries: Anniversary[]) { const today = todayIso().slice(5); const cards: string[] = []; const lastYear = diaries.find(d => d.date?.slice(5) === today); if (lastYear) cards.push(`過去の今日: ${lastYear.title}`); const month = todayIso().slice(0, 7); const monthDiary = diaries.filter(d => d.date?.startsWith(month)); if (monthDiary.length) cards.push(`今月の日記は${monthDiary.length}件あります`); const monthExpense = expenses.filter(e => e.date?.startsWith(month)).reduce((s, e) => s + Number(e.amountBase || 0), 0); if (monthExpense) cards.push(`今月の支出は${yen(monthExpense)}です`); const upcomingAnniv = anniversaries.find(a => a.date?.slice(5) >= today); if (upcomingAnniv) cards.push(`次の記念日: ${upcomingAnniv.title}（${upcomingAnniv.date}）`); return cards.slice(0, 4); }
