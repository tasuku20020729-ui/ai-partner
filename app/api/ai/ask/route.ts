import OpenAI from 'openai';
import { askBodySchema, validationError } from '@/lib/apiSchemas';
import { adminDb } from '@/lib/firebaseAdmin';
import { cosineSimilarity, embedText } from '@/lib/rag';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

type Body = { question: string; partnerName?: string; partnerRelationship?: string; currentUserId?: string; groupId?: string; spaceIds?: string[]; data: any };
type QuestionIntent = 'expense' | 'event' | 'todo' | 'diary' | 'memo' | 'anniversary' | 'out_of_scope' | 'unknown';
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DAY = 86400000;
const today = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;
const expenseCategoryLabel: Record<string, string> = {
  food: '食費',
  daily_goods: '日用品',
  dating: '交際費',
  transport: '交通費',
  travel: '旅行',
  medical: '医療費',
  entertainment: '娯楽',
  other: 'その他'
};
const priorityLabel: Record<string, string> = { high: '高', middle: '中', low: '低' };

function dayRange(base: Date, offset: number, label: string) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end, label };
}
function monthRange(base: Date, offset: number, label: string) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  start.setMonth(start.getMonth() + offset, 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1, 1);
  return { start, end, label };
}
function yearRange(base: Date, offset: number, label: string) {
  const start = new Date(base);
  start.setFullYear(start.getFullYear() + offset, 0, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1, 0, 1);
  return { start, end, label };
}
function weekRange(base: Date, offsetWeeks: number, label: string) {
  const start = new Date(base);
  start.setHours(0, 0, 0, 0);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end, label };
}
function monthEndRange(base: Date, offset: number, label: string) {
  const end = monthRange(base, offset, label).end;
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start, end, label };
}
function explicitDateRange(q: string, base: Date) {
  const slash = q.match(/(?:(20\d{2})[\/年.-])?(\d{1,2})[\/月.-](\d{1,2})日?/);
  if (slash) {
    const year = slash[1] ? Number(slash[1]) : base.getFullYear();
    const month = Number(slash[2]);
    const day = Number(slash[3]);
    const start = new Date(base); start.setFullYear(year, month - 1, day); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end, label: `${month}/${day}` };
  }
  const dayOnly = q.match(/(?:^|[^\d])(\d{1,2})日(?:[^\d]|$)/);
  if (dayOnly && !/今日|明日|昨日|後日|日前|日後/.test(q)) {
    const day = Number(dayOnly[1]);
    const start = new Date(base); start.setDate(day); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { start, end, label: `${start.getMonth() + 1}/${day}` };
  }
  return null;
}
function rangeFromQuestion(q: string) {
  const base = today();
  const explicit = explicitDateRange(q, base);
  if (explicit) return explicit;
  const daysAgo = q.match(/(\d{1,2})日前/);
  if (daysAgo) return dayRange(base, -Number(daysAgo[1]), `${daysAgo[1]}日前`);
  const daysLater = q.match(/(\d{1,2})日後/);
  if (daysLater) return dayRange(base, Number(daysLater[1]), `${daysLater[1]}日後`);
  if (/明後日/.test(q)) return dayRange(base, 2, '明後日');
  if (/明日/.test(q)) return dayRange(base, 1, '明日');
  if (/今日|本日/.test(q)) return dayRange(base, 0, '今日');
  if (/一昨日/.test(q)) return dayRange(base, -2, '一昨日');
  if (/昨日/.test(q)) return dayRange(base, -1, '昨日');
  if (/来週末/.test(q)) {
    const week = weekRange(base, 1, '来週末');
    const start = new Date(week.start); start.setDate(start.getDate() + 5);
    return { start, end: week.end, label: '来週末' };
  }
  if (/今週末|週末/.test(q)) {
    const week = weekRange(base, 0, '今週末');
    const start = new Date(week.start); start.setDate(start.getDate() + 5);
    return { start, end: week.end, label: '今週末' };
  }
  if (/今月末/.test(q)) return monthEndRange(base, 0, '今月末');
  if (/来月末/.test(q)) return monthEndRange(base, 1, '来月末');
  if (/今年|本年/.test(q)) return yearRange(base, 0, '今年');
  if (/去年|昨年/.test(q)) return yearRange(base, -1, '去年');
  if (/来年/.test(q)) return yearRange(base, 1, '来年');
  if (/先月/.test(q)) return monthRange(base, -1, '先月');
  if (/来月/.test(q)) return monthRange(base, 1, '来月');
  if (/今月/.test(q)) return monthRange(base, 0, '今月');
  if (/先週/.test(q)) return weekRange(base, -1, '先週');
  if (/来週/.test(q)) return weekRange(base, 1, '来週');
  if (/今週/.test(q)) return weekRange(base, 0, '今週');
  return null;
}
function inRange(dateText: string | undefined, range: ReturnType<typeof rangeFromQuestion>) {
  if (!dateText || !range) return true;
  const d = new Date(dateText); if (Number.isNaN(d.getTime())) return true;
  return d >= range.start && d < range.end;
}
function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function wantsAllOwners(q: string) {
  return /2人|二人|ふたり|両方|全員|全部|全体|みんな|共有/.test(q);
}
function wantsSelfOwner(q: string) {
  return /自分の|私の|俺の|僕の|わたしの|自分が|私が|俺が|僕が|自分だけ/.test(q);
}
function wantsPartnerOwner(q: string, partnerName?: string, partnerRelationship?: string) {
  if (/彼女の|彼氏の|相手の|パートナーの|向こうの/.test(q)) return true;
  if (partnerName && new RegExp(`${escapeRegExp(partnerName)}(の|が|は|だけ)`).test(q)) return true;
  return Boolean(partnerRelationship && new RegExp(`${escapeRegExp(partnerRelationship)}(の|が|は|だけ)`).test(q));
}
function mentionedMemberIds(q: string, members: any[] = []) {
  const hints = Array.from(q.matchAll(/([一-龥ぁ-んァ-ヶA-Za-z0-9]+)の/g)).map(match => match[1]).filter(Boolean);
  return Array.from(new Set(members.filter((member:any) => {
    const names = [member.displayName, ...(member.aliases || []), ...(member.relationshipLabels || [])].map(value => String(value || '').trim()).filter(Boolean);
    return names.some(name => q.includes(name) || hints.some(hint => name.includes(hint) || hint.includes(name)));
  }).map((member:any) => String(member.userId || '')).filter(Boolean)));
}
function ownerMatch(item: any, q: string, partnerName?: string, partnerRelationship?: string, currentUserId?: string, members: any[] = []) {
  if (wantsAllOwners(q)) return true;
  const memberIds = mentionedMemberIds(q, members);
  if (memberIds.length) return memberIds.includes(String(item.userId || item.createdBy || ''));
  if (item.ownerName && q.includes(item.ownerName)) return true;
  if (wantsPartnerOwner(q, partnerName, partnerRelationship)) return item.userId !== currentUserId;
  if (wantsSelfOwner(q)) return item.userId === currentUserId;
  if (item.ownerName && /さん|くん|ちゃん/.test(q)) return q.includes(item.ownerName);
  return true;
}
function mentionedSpaceNames(q: string, data: any) {
  const items = [
    ...(data.diaries || []),
    ...(data.events || []),
    ...(data.todos || []),
    ...(data.expenses || []),
    ...(data.anniversaries || []),
    ...(data.sharedNotes || [])
  ];
  const hints = Array.from(q.matchAll(/([一-龥ぁ-んァ-ヶA-Za-z0-9]+)の/g)).map(match => match[1]).filter(Boolean);
  return Array.from(new Set(items.map((item:any) => String(item.spaceName || '')).filter(name => name && (q.includes(name) || hints.some(hint => name.includes(hint) || hint.includes(name))))));
}
function spaceMatch(item: any, spaces: string[]) {
  return !spaces.length || spaces.includes(String(item.spaceName || ''));
}
function scoped(body: Body) {
  const q = body.question || '';
  const range = rangeFromQuestion(q);
  const data = body.data || {};
  const spaces = mentionedSpaceNames(q, data);
  const members = data.members || [];
  return {
    range,
    diaries: (data.diaries || []).filter((d:any)=>spaceMatch(d, spaces) && inRange(d.date, range) && ownerMatch(d, q, body.partnerName, body.partnerRelationship, body.currentUserId, members)),
    events: (data.events || []).filter((e:any)=>spaceMatch(e, spaces) && inRange(e.startAt, range) && ownerMatch(e, q, body.partnerName, body.partnerRelationship, body.currentUserId, members)),
    todos: (data.todos || []).filter((t:any)=>spaceMatch(t, spaces) && inRange(t.dueAt || t.createdAt, range) && ownerMatch(t, q, body.partnerName, body.partnerRelationship, body.currentUserId, members)),
    expenses: (data.expenses || []).filter((e:any)=>spaceMatch(e, spaces) && inRange(e.date, range) && ownerMatch(e, q, body.partnerName, body.partnerRelationship, body.currentUserId, members)),
    anniversaries: (data.anniversaries || []).filter((a:any)=>spaceMatch(a, spaces)),
    sharedNotes: (data.sharedNotes || []).filter((n:any)=>spaceMatch(n, spaces))
  };
}
function sumExpenses(list: any[]) { return list.reduce((s, e) => s + Number(e.amountBase || e.amount || 0), 0); }
function formatDateTime(value?: string) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function filterExpenseCategory(q: string, expenses: any[]) {
  if (/食費|食事|ごはん|ご飯|ランチ|昼食|夕食|晩ごはん|朝食|カフェ|喫茶|飲食|レストラン|居酒屋|スーパー|食品|食材|コンビニ|セブン|ローソン|ファミマ|スタバ|マック|マクド|GrabFood|Uber Eats|出前/.test(q)) return expenses.filter((e:any)=>e.category === 'food');
  if (/日用品|生活用品|洗剤|ティッシュ|トイレットペーパー|シャンプー|石鹸|せっけん|歯ブラシ|歯磨き|掃除|雑貨|ドラッグストアの日用品/.test(q)) return expenses.filter((e:any)=>e.category === 'daily_goods');
  if (/デート|交際|プレゼント|ギフト|記念日|花|彼女|彼氏|パートナー/.test(q)) return expenses.filter((e:any)=>e.category === 'dating');
  if (/交通|電車|地下鉄|バス|タクシー|Grab|Uber|駐車|高速|ガソリン|Suica|PASMO|切符|運賃|航空券だけ/.test(q)) return expenses.filter((e:any)=>e.category === 'transport');
  if (/旅行|ホテル|宿泊|航空券|飛行機|新幹線|旅館|Airbnb|観光|ツアー|レンタカー/.test(q)) return expenses.filter((e:any)=>e.category === 'travel');
  if (/医療|病院|薬|薬局|ドラッグストア|診察|歯医者|クリニック|処方|サプリ|コンタクト/.test(q)) return expenses.filter((e:any)=>e.category === 'medical');
  if (/娯楽|映画|ゲーム|ライブ|コンサート|イベント|本|漫画|サブスク|Netflix|Spotify|カラオケ|遊び|チケット/.test(q)) return expenses.filter((e:any)=>e.category === 'entertainment');
  return expenses;
}
function classifyQuestion(q: string): QuestionIntent {
  const text = q.trim();
  if (!text) return 'unknown';
  if (/天気|ニュース|株価|為替|一般知識|とは|教えて$|作って|翻訳|コード|プログラム|レシピ/.test(text) && !/日記|予定|ToDo|todo|タスク|支出|お金|メモ|記念日|誕生日|共有/.test(text)) return 'out_of_scope';
  if (/記念日|誕生日|付き合った日|結婚記念/.test(text)) return 'anniversary';
  if (/メモ|共有メモ|ノート/.test(text)) return 'memo';
  if (/いくら|合計|平均|支出|使った|費用|出費|食費|デート代|交通費|日用品|医療費|娯楽費|旅行代|お金|金額|内訳|カテゴリ/.test(text)) return 'expense';
  if (/ToDo|todo|タスク|課題|やること|未完了|完了済み|完了した|期限|提出/.test(text)) return 'todo';
  if (/予定|スケジュール|空き|何がある|集合|会議|予約|イベント|リマインド/.test(text)) return 'event';
  if (/日記|思い出|覚えてる|何した|どこ行った|楽しかった|嬉しかった|悲しかった|気分|振り返り/.test(text)) return 'diary';
  return 'unknown';
}
function deterministicAnswer(body: Body) {
  const q = body.question || '';
  const intent = classifyQuestion(q);
  if (intent === 'out_of_scope') return 'このAIは登録された日記・予定・ToDo・支出・記念日・共有メモについて回答します。生活データに関する質問を入力してください。';
  const s = scoped(body);
  const rangeLabel = s.range?.label ? `${s.range.label}の` : '';

  if (intent === 'expense') {
    const expenses = filterExpenseCategory(q, s.expenses).sort((a:any, b:any) => Number(b.amountBase || b.amount || 0) - Number(a.amountBase || a.amount || 0));
    const total = sumExpenses(expenses);
    const average = expenses.length ? total / expenses.length : 0;
    const categoryTotals = expenses.reduce((acc: Record<string, number>, e:any) => {
      const key = expenseCategoryLabel[e.category] || e.category || 'その他';
      acc[key] = (acc[key] || 0) + Number(e.amountBase || e.amount || 0);
      return acc;
    }, {});
    const categoryLines = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `・${k}: ${yen(v)}`).join('\n');
    const detailLines = expenses.slice(0, 12).map((e:any)=>`・${e.date || ''} ${e.title || e.shopName || '支出'}: ${yen(Number(e.amountBase || e.amount || 0))}${e.spaceName ? ` / ${e.spaceName}` : ''}${e.currency && e.currency !== 'JPY' ? `（元額 ${Number(e.amount || 0).toLocaleString()}${e.currency}）` : ''}`).join('\n');
    return `${rangeLabel}参照可能な支出は ${expenses.length}件、合計 ${yen(total)} です。${expenses.length ? `平均は ${yen(average)} です。` : ''}${categoryLines ? `\n\nカテゴリ別:\n${categoryLines}` : ''}${detailLines ? `\n\n内訳:\n${detailLines}` : ''}`;
  }

  if (intent === 'event') {
    const events = s.events.sort((a:any, b:any) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
    const lines = events.slice(0, 20).map((e:any)=>`・${formatDateTime(e.startAt)} ${e.title || '予定'}${e.location ? ` @${e.location}` : ''}（${e.ownerName || '不明'}${e.spaceName ? ` / ${e.spaceName}` : ''}）`).join('\n');
    return lines ? `${rangeLabel}予定は ${events.length}件あります。\n${lines}` : `${rangeLabel}参照可能な予定はありません。`;
  }

  if (intent === 'todo') {
    const wantsDone = /完了済み|完了した/.test(q);
    const todos = s.todos
      .filter((t:any)=>wantsDone ? t.status === 'done' : t.status !== 'done')
      .sort((a:any, b:any) => {
        const priority = { high: 0, middle: 1, low: 2 } as Record<string, number>;
        return (priority[a.priority] ?? 3) - (priority[b.priority] ?? 3) || String(a.dueAt || '').localeCompare(String(b.dueAt || ''));
      });
    const lines = todos.slice(0, 20).map((t:any)=>`・${t.title}${t.dueAt ? ` 期限:${t.dueAt}` : ''} 優先度:${priorityLabel[t.priority] || t.priority || '-'}（${t.ownerName || '不明'}${t.spaceName ? ` / ${t.spaceName}` : ''}）`).join('\n');
    return lines ? `${rangeLabel}${wantsDone ? '完了済み' : '未完了'}ToDoは ${todos.length}件あります。\n${lines}` : `${rangeLabel}${wantsDone ? '完了済み' : '未完了'}ToDoはありません。`;
  }

  if (intent === 'anniversary') {
    const anniversaries = (s.anniversaries || []).sort((a:any, b:any) => String(a.date || '').localeCompare(String(b.date || '')));
    const lines = anniversaries.map((a:any)=>`・${a.date} ${a.title}${a.repeat === 'yearly' ? '（毎年）' : ''}`).join('\n');
    return lines || '登録済みの記念日はありません。';
  }

  if (intent === 'memo') {
    const lines = (s.sharedNotes || []).map((n:any)=>`・${n.title}: ${n.content}`).join('\n');
    return lines || '共有メモはありません。';
  }

  return null;
}

async function searchRagMemory(body: Body) {
  if (!body.groupId || !process.env.OPENAI_API_KEY) return { results: [] as any[], unavailable: true };
  try {
    const qEmbedding = await embedText(body.question);
    const targetSpaceIds = Array.from(new Set((body.spaceIds?.length ? body.spaceIds : [body.groupId]).filter(Boolean))).slice(0, 30);
    const snaps = await Promise.all(targetSpaceIds.map(spaceId => adminDb().collection('aiMemory').where('groupId', '==', spaceId).get()));
    const wantsAll = wantsAllOwners(body.question);
    const wantsPartner = wantsPartnerOwner(body.question, body.partnerName, body.partnerRelationship);
    const wantsSelf = wantsSelfOwner(body.question);
    const memberIds = mentionedMemberIds(body.question, body.data?.members || []);
    const hints = Array.from(body.question.matchAll(/([一-龥ぁ-んァ-ヶA-Za-z0-9]+)の/g)).map(match => match[1]).filter(Boolean);
    const mentionedSpaces = Array.from(new Set(snaps.flatMap(snap => snap.docs.map(d => String(d.data().spaceName || ''))).filter(name => name && (body.question.includes(name) || hints.some(hint => name.includes(hint) || hint.includes(name))))));
    const candidates = snaps.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() } as any))).filter((m:any) => {
      if (m.aiReadable === false) return false;
      if (mentionedSpaces.length && !mentionedSpaces.includes(String(m.spaceName || ''))) return false;
      const isMine = m.userId === body.currentUserId;
      if (!isMine && m.visibility !== 'shared') return false;
      if (wantsAll) return true;
      if (memberIds.length) return memberIds.includes(String(m.userId || ''));
      if (m.ownerName && body.question.includes(m.ownerName)) return true;
      if (wantsPartner) return !isMine;
      if (wantsSelf) return isMine;
      if (m.ownerName && /さん|くん|ちゃん/.test(body.question)) return body.question.includes(m.ownerName);
      return true;
    });
    const scored = candidates
      .filter((m:any) => Array.isArray(m.embedding))
      .map((m:any) => ({ ...m, score: cosineSimilarity(qEmbedding, m.embedding) }))
      .sort((a:any,b:any) => b.score - a.score)
      .slice(0, 18);
    return { results: scored, unavailable: false };
  } catch (e) {
    return { results: [] as any[], unavailable: true, error: e instanceof Error ? e.message : 'RAG search failed' };
  }
}

function fallbackAnswer(body: Body) {
  const exact = deterministicAnswer(body);
  if (exact) return exact;
  const q = body.question || '';
  const s = scoped(body);
  const rangeLabel = s.range?.label ? `${s.range.label}の` : '';
  if (/食費/.test(q)) s.expenses = s.expenses.filter((e:any)=>e.category === 'food');
  if (/デート|交際/.test(q)) s.expenses = s.expenses.filter((e:any)=>e.category === 'dating');
  if (/交通/.test(q)) s.expenses = s.expenses.filter((e:any)=>e.category === 'transport');
  if (/いくら|食費|支出|使った|デート代|平均/.test(q)) {
    const total = sumExpenses(s.expenses);
    const lines = s.expenses.slice(0, 12).map((e:any)=>`・${e.date} ${e.title || e.shopName || '支出'} ${Number(e.amount).toLocaleString()}${e.currency}（${yen(Number(e.amountBase || e.amount || 0))}換算）`).join('\n');
    return `${rangeLabel}参照可能な支出合計は ${yen(total)} です。${lines ? `\n\n内訳:\n${lines}` : ''}`;
  }
  if (/予定|空き|彼女|彼氏|パートナー/.test(q)) {
    const list = s.events.slice(0, 20).map((e:any)=>`・${e.startAt || ''} ${e.title}（${e.ownerName || '不明'}）`).join('\n');
    return list ? `${rangeLabel}予定です。\n${list}` : `${rangeLabel}参照可能な予定はありません。`;
  }
  if (/ToDo|todo|課題|やる|未完了/.test(q)) {
    const list = s.todos.filter((t:any)=>t.status!=='done').map((t:any)=>`・${t.title}${t.dueAt ? ` 期限:${t.dueAt}` : ''}（${t.ownerName || '不明'}）`).join('\n');
    return list || '未完了ToDoはありません。';
  }
  if (/記念日|誕生日/.test(q)) return (s.anniversaries || []).map((a:any)=>`・${a.date} ${a.title}`).join('\n') || '登録済みの記念日はありません。';
  if (/メモ|共有/.test(q)) return (s.sharedNotes || []).map((n:any)=>`・${n.title}: ${n.content}`).join('\n') || '共有メモはありません。';
  const list = s.diaries.slice(0, 10).map((d:any)=>`・${d.date} ${d.title}: ${d.content || ''}`).join('\n');
  return list || '関連データが見つかりませんでした。';
}

export async function POST(req: Request) {
  let auth: Awaited<ReturnType<typeof requireAuth>>;
  try {
    auth = await requireAuth(req);
  } catch {
    return unauthorized();
  }
  let rawBody: Body;
  try {
    rawBody = askBodySchema.parse(await req.json()) as Body;
  } catch (e) {
    const invalid = validationError(e);
    if (invalid) return invalid;
    throw e;
  }
  const requestedSpaceIds = rawBody.spaceIds?.filter(spaceId => auth.spaceIds.includes(spaceId));
  const body = { ...rawBody, currentUserId: auth.uid, groupId: auth.groupId, spaceIds: requestedSpaceIds?.length ? requestedSpaceIds : [auth.groupId] };
  const intent = classifyQuestion(body.question || '');
  const filtered = scoped(body);
  const exactAnswer = deterministicAnswer(body);
  if (exactAnswer) return Response.json({ answer: exactAnswer, deterministic: true, intent });
  if (!process.env.OPENAI_API_KEY) return Response.json({ answer: fallbackAnswer(body), fallback: true });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rag = await searchRagMemory(body);
  const compactData = {
    diaries: filtered.diaries.slice(0, 60),
    events: filtered.events.slice(0, 100),
    todos: filtered.todos.slice(0, 100),
    expenses: filtered.expenses.slice(0, 160),
    anniversaries: filtered.anniversaries.slice(0, 50),
    sharedNotes: filtered.sharedNotes.slice(0, 50),
    members: (body.data?.members || []).slice(0, 100)
  };
  const ragContext = rag.results.map((m:any, i:number) => ({
    rank: i + 1,
    score: Number(m.score || 0).toFixed(3),
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    ownerName: m.ownerName,
    spaceName: m.spaceName,
    date: m.date,
    title: m.title,
    text: m.contentText
  }));
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: `あなたはAI生活管理アプリのAIです。日記・予定・ToDo・支出・記念日・共有メモだけを根拠に日本語で回答します。今日=${new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}。相手の名前=${body.partnerName || '未設定'}。相手との関係性=${body.partnerRelationship || '未設定'}。分類済み意図=${intent}。入力データ以外を推測しない。支出はamountBase(JPY)で計算し、必要なら内訳を示す。相手の名前・関係性・メンバーのaliases/relationshipLabelsで質問された場合は該当メンバーのデータとして扱う。intent=diary または曖昧な思い出検索・感情・キーワード検索ではRAG結果を優先し、日付や金額の厳密集計は構造化データを優先する。intent=out_of_scopeなら生活データに関する質問だけ回答できると伝える。` },
      { role: 'user', content: `質問: ${body.question}

期間推定: ${filtered.range ? `${iso(filtered.range.start)}〜${iso(filtered.range.end)}` : '指定なし'}

RAG類似検索結果(JSON):
${JSON.stringify(ragContext)}

構造化データ(JSON):
${JSON.stringify(compactData)}` }
    ]
  });
  return Response.json({ answer: response.output_text, intent, ragUsed: rag.results.length > 0, ragCount: rag.results.length, ragUnavailable: rag.unavailable });
}
