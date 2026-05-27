import OpenAI from 'openai';
import { askBodySchema, validationError } from '@/lib/apiSchemas';
import { adminDb } from '@/lib/firebaseAdmin';
import { cosineSimilarity, embedText } from '@/lib/rag';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

type ChatHistoryItem = { role: 'user' | 'ai'; content: string };
type Body = { question: string; partnerName?: string; partnerRelationship?: string; currentUserId?: string; groupId?: string; spaceIds?: string[]; chatHistory?: ChatHistoryItem[]; data: any };
type QuestionIntent = 'expense' | 'event' | 'todo' | 'diary' | 'memo' | 'anniversary' | 'out_of_scope' | 'unknown';
type SearchPlan = {
  contextualizedQuestion: string;
  intent: QuestionIntent;
  answerMode: 'summary' | 'detail' | 'aggregate' | 'search';
  keywords: string[];
  sourceTypes: string[];
  ownerHint?: 'self' | 'partner' | 'all' | 'unknown';
};
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
function safeJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}
function fallbackSearchPlan(question: string): SearchPlan {
  const intent = classifyQuestion(question);
  return {
    contextualizedQuestion: question,
    intent,
    answerMode: detailQuestion(question) ? 'detail' : /いくら|合計|平均|内訳/.test(question) ? 'aggregate' : 'summary',
    keywords: detailHints(question),
    sourceTypes: sourceTypesForIntent(intent),
    ownerHint: wantsSelfOwner(question) ? 'self' : wantsAllOwners(question) ? 'all' : wantsPartnerOwner(question) ? 'partner' : 'unknown'
  };
}
function sourceTypesForIntent(intent: QuestionIntent) {
  if (intent === 'memo') return ['sharedNote'];
  if (['diary', 'event', 'todo', 'expense', 'anniversary'].includes(intent)) return [intent];
  return [];
}
function validIntent(value: unknown): QuestionIntent {
  return ['expense', 'event', 'todo', 'diary', 'memo', 'anniversary', 'out_of_scope', 'unknown'].includes(String(value)) ? value as QuestionIntent : 'unknown';
}
function cleanStringList(value: unknown, limit = 12) {
  return Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean).slice(0, limit) : [];
}
async function buildSearchPlan(client: OpenAI, body: Body): Promise<SearchPlan> {
  const fallback = fallbackSearchPlan(body.question || '');
  try {
    const history = (body.chatHistory || []).slice(-8).map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n');
    const res = await client.responses.create({
      model,
      input: [
        { role: 'system', content: '生活管理アプリの検索計画をJSONだけで返します。会話履歴がある場合、「それ」「さっきの」「この前」などを具体化してください。intentはexpense,event,todo,diary,memo,anniversary,out_of_scope,unknown。answerModeはsummary,detail,aggregate,search。sourceTypesはdiary,event,todo,expense,anniversary,sharedNoteから選びます。推測しすぎず、生活データ検索に必要なキーワードを短く抽出してください。' },
        { role: 'user', content: `会話履歴:\n${history || 'なし'}\n\n現在の質問:\n${body.question}\n\n返すJSONキー: contextualizedQuestion,intent,answerMode,keywords,sourceTypes,ownerHint` }
      ]
    });
    const parsed = safeJsonObject(res.output_text || '');
    if (!parsed) return fallback;
    const intent = validIntent(parsed.intent);
    const answerMode = ['summary', 'detail', 'aggregate', 'search'].includes(String(parsed.answerMode)) ? parsed.answerMode as SearchPlan['answerMode'] : fallback.answerMode;
    const contextualizedQuestion = String(parsed.contextualizedQuestion || body.question || '').trim() || body.question;
    return {
      contextualizedQuestion,
      intent,
      answerMode,
      keywords: cleanStringList(parsed.keywords).length ? cleanStringList(parsed.keywords) : detailHints(contextualizedQuestion),
      sourceTypes: cleanStringList(parsed.sourceTypes).length ? cleanStringList(parsed.sourceTypes, 6) : sourceTypesForIntent(intent),
      ownerHint: ['self', 'partner', 'all', 'unknown'].includes(String(parsed.ownerHint)) ? parsed.ownerHint : fallback.ownerHint
    };
  } catch {
    return fallback;
  }
}
function compactText(value: unknown) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}
function detailQuestion(q: string) {
  return /詳しく|詳細|内容|説明|メモ|何を|なにを|どう|どんな|について|とは|中身|補足|深く|具体|場所|どこ|いつ|何時|金額|内訳|理由|用途/.test(q);
}
function looseDetailQuestion(q: string) {
  return detailQuestion(q) || /何|なに|教えて|いくら/.test(q);
}
function detailHints(q: string) {
  const explicit = Array.from(q.matchAll(/(.+?)(?:について|とは|の詳細|を詳しく|を教えて|の内容|の説明|の場所|の金額|の内訳)/g)).map(match => match[1]);
  const words = q
    .replace(/今日|本日|明日|明後日|昨日|一昨日|今週末|来週末|週末|今週|来週|先週|今月末|来月末|今月|来月|先月|今年|来年|去年|昨年|本年|日記|予定|スケジュール|イベント|ToDo|todo|タスク|やること|支出|出費|費用|お金|記念日|誕生日|メモ|共有メモ|ノート|未完了|完了済み|完了した|詳しく|詳細|内容|説明|メモ|何|なに|どう|どんな|について|とは|中身|補足|深く|具体|教えて|場所|どこ|いつ|何時|いくら|金額|内訳|理由|用途|期限|優先度|リマインド/g, ' ')
    .split(/[\s、。・/／,，?？!！]+/)
    .filter(word => word.length >= 2);
  const stopWords = new Set(['今日', '本日', '明日', '明後日', '昨日', '一昨日', '今週末', '来週末', '週末', '今週', '来週', '先週', '今月末', '来月末', '今月', '来月', '先月', '今年', '来年', '去年', '昨年', '本年', '日記', '予定', 'スケジュール', 'イベント', 'todo', 'タスク', 'やること', '支出', '出費', '費用', 'お金', '記念日', '誕生日', 'メモ', '共有メモ', 'ノート']);
  return Array.from(new Set([...explicit, ...words]
    .map(word => compactText(word).replace(/の$/g, '').replace(/^(今日|本日|明日|明後日|昨日|一昨日|今週末|来週末|週末|今週|来週|先週|今月末|来月末|今月|来月|先月|今年|来年|去年|昨年|本年)/, ''))
    .map(word => word.replace(/(日記|予定|スケジュール|イベント|todo|タスク|やること|支出|出費|費用|お金|記念日|誕生日|メモ|共有メモ|ノート)$/g, ''))
    .filter(word => word && word.length >= 2 && !stopWords.has(word))));
}
function detailSearchText(kind: QuestionIntent, item: any) {
  if (kind === 'expense') {
    return [
      item.title,
      item.shopName,
      item.memo,
      item.category,
      expenseCategoryLabel[item.category],
      item.paymentMethod,
      item.currency,
      item.date,
      ...(item.receiptItems || []),
      item.ownerName,
      item.spaceName
    ].filter(Boolean).join(' ');
  }
  if (kind === 'event') return [item.title, item.description, item.location, item.startAt, item.endAt, item.ownerName, item.spaceName].filter(Boolean).join(' ');
  if (kind === 'todo') return [item.title, item.description, item.ownerName, item.spaceName, item.dueAt].filter(Boolean).join(' ');
  if (kind === 'diary') return [item.title, item.content, item.mood, ...(item.tags || []), item.date, item.ownerName, item.spaceName].filter(Boolean).join(' ');
  if (kind === 'anniversary') return [item.title, item.date, item.repeat, item.ownerName, item.spaceName].filter(Boolean).join(' ');
  if (kind === 'memo') return [item.title, item.content, item.createdByName, item.ownerName, item.spaceName].filter(Boolean).join(' ');
  return '';
}
function detailScore(q: string, kind: QuestionIntent, item: any) {
  const hints = detailHints(q);
  if (!hints.length) return 1;
  const haystack = compactText(detailSearchText(kind, item));
  return hints.reduce((score, hint) => score + (haystack.includes(hint) ? hint.length : 0), 0);
}
function rankedDetails(q: string, kind: QuestionIntent, items: any[]) {
  return items
    .map(item => ({ item, score: detailScore(q, kind, item) }))
    .filter(result => result.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (kind === 'expense') return Number(b.item.amountBase || b.item.amount || 0) - Number(a.item.amountBase || a.item.amount || 0) || String(b.item.date || '').localeCompare(String(a.item.date || ''));
      if (kind === 'event') return String(a.item.startAt || '').localeCompare(String(b.item.startAt || ''));
      if (kind === 'todo') {
        const priority = { high: 0, middle: 1, low: 2 } as Record<string, number>;
        return (priority[a.item.priority] ?? 3) - (priority[b.item.priority] ?? 3) || String(a.item.dueAt || '').localeCompare(String(b.item.dueAt || ''));
      }
      return String(b.item.date || b.item.updatedAt || b.item.createdAt || '').localeCompare(String(a.item.date || a.item.updatedAt || a.item.createdAt || ''));
    })
    .map(result => result.item);
}
function detailCollection(kind: QuestionIntent, s: ReturnType<typeof scoped>) {
  if (kind === 'expense') return s.expenses;
  if (kind === 'event') return s.events;
  if (kind === 'todo') return s.todos;
  if (kind === 'diary') return s.diaries;
  if (kind === 'anniversary') return s.anniversaries;
  if (kind === 'memo') return s.sharedNotes;
  return [];
}
function detailIntent(q: string, intent: QuestionIntent, s: ReturnType<typeof scoped>) {
  const canUseLooseMatch = intent === 'unknown' || intent === 'out_of_scope';
  const supported: QuestionIntent[] = ['expense', 'event', 'todo', 'diary', 'anniversary', 'memo'];
  const hints = detailHints(q);
  const expenseCategoryHints = new Set(['食費', '食事', '交通費', '日用品', '生活用品', 'デート代', '交際費', '医療費', '娯楽費', '旅行代', 'カテゴリ']);
  const canUseExpenseLooseMatch = intent === 'expense' && looseDetailQuestion(q) && hints.length > 0 && !/合計|平均/.test(q) && !hints.every(hint => expenseCategoryHints.has(hint));
  const canUseKnownLooseMatch = supported.includes(intent) && looseDetailQuestion(q) && hints.length > 0 && (intent !== 'expense' || canUseExpenseLooseMatch);
  if (!(canUseLooseMatch ? looseDetailQuestion(q) : detailQuestion(q) || canUseKnownLooseMatch)) return null;
  if (supported.includes(intent) && rankedDetails(q, intent, detailCollection(intent, s)).length) return intent;
  const best = supported
    .map(kind => ({ kind, max: Math.max(0, ...detailCollection(kind, s).map((item:any) => detailScore(q, kind, item))) }))
    .filter(result => result.max > 0)
    .sort((a, b) => b.max - a.max)[0];
  return best?.kind || null;
}
function todoDetailRequested(q: string) {
  return detailQuestion(q) && /ToDo|todo|タスク|課題|やること|期限|提出|買う|準備|確認|支払/.test(q);
}
function todoHints(q: string) {
  return detailHints(q);
}
function todoScore(q: string, todo: any) {
  return detailScore(q, 'todo', todo);
}
function formatTodoDetail(todo: any) {
  const fields = [
    `タイトル: ${todo.title || 'ToDo'}`,
    `状態: ${todo.status === 'done' ? '完了' : '未完了'}`,
    todo.dueAt ? `期限: ${todo.dueAt}` : '',
    `優先度: ${priorityLabel[todo.priority] || todo.priority || '-'}`,
    todo.reminderEnabled && todo.remindAt ? `リマインド: ${formatDateTime(todo.remindAt)}` : '',
    todo.description ? `内容: ${todo.description}` : '',
    `登録者: ${todo.ownerName || '不明'}${todo.spaceName ? ` / ${todo.spaceName}` : ''}`
  ].filter(Boolean);
  return fields.join('\n');
}
function formatDetail(kind: QuestionIntent, item: any) {
  if (kind === 'todo') return formatTodoDetail(item);
  if (kind === 'event') return [
    `予定: ${item.title || '予定'}`,
    item.startAt ? `開始: ${formatDateTime(item.startAt)}` : '',
    item.endAt ? `終了: ${formatDateTime(item.endAt)}` : '',
    item.location ? `場所: ${item.location}` : '',
    item.reminderEnabled && item.remindAt ? `リマインド: ${formatDateTime(item.remindAt)}` : '',
    item.description ? `内容: ${item.description}` : '',
    `登録者: ${item.ownerName || '不明'}${item.spaceName ? ` / ${item.spaceName}` : ''}`
  ].filter(Boolean).join('\n');
  if (kind === 'expense') return [
    `支出: ${item.title || item.shopName || '支出'}`,
    item.date ? `日付: ${item.date}` : '',
    item.shopName ? `店名: ${item.shopName}` : '',
    `金額: ${yen(Number(item.amountBase || item.amount || 0))}${item.currency && item.currency !== 'JPY' ? `（元額 ${Number(item.amount || 0).toLocaleString()}${item.currency}）` : ''}`,
    `カテゴリ: ${expenseCategoryLabel[item.category] || item.category || 'その他'}`,
    item.paymentMethod ? `支払い方法: ${item.paymentMethod}` : '',
    item.memo ? `メモ: ${item.memo}` : '',
    item.receiptItems?.length ? `明細: ${item.receiptItems.join('、')}` : '',
    `登録者: ${item.ownerName || '不明'}${item.spaceName ? ` / ${item.spaceName}` : ''}`
  ].filter(Boolean).join('\n');
  if (kind === 'diary') return [
    `日記: ${item.title || '日記'}`,
    item.date ? `日付: ${item.date}` : '',
    item.mood ? `気分: ${item.mood}` : '',
    item.tags?.length ? `タグ: ${item.tags.join('、')}` : '',
    item.content ? `内容: ${item.content}` : '',
    `登録者: ${item.ownerName || '不明'}${item.spaceName ? ` / ${item.spaceName}` : ''}`
  ].filter(Boolean).join('\n');
  if (kind === 'anniversary') return [
    `記念日: ${item.title || '記念日'}`,
    item.date ? `日付: ${item.date}` : '',
    `繰り返し: ${item.repeat === 'yearly' ? '毎年' : '一回'}`,
    item.remindDaysBefore !== undefined ? `通知: ${item.remindDaysBefore}日前` : '',
    `登録者: ${item.ownerName || '不明'}${item.spaceName ? ` / ${item.spaceName}` : ''}`
  ].filter(Boolean).join('\n');
  if (kind === 'memo') return [
    `メモ: ${item.title || '共有メモ'}`,
    item.content ? `内容: ${item.content}` : '',
    item.updatedAt ? `更新: ${formatDateTime(item.updatedAt)}` : item.createdAt ? `作成: ${formatDateTime(item.createdAt)}` : '',
    `登録者: ${item.createdByName || item.ownerName || '不明'}${item.spaceName ? ` / ${item.spaceName}` : ''}`
  ].filter(Boolean).join('\n');
  return '';
}
function detailAnswer(q: string, kind: QuestionIntent, items: any[], rangeLabel: string) {
  const details = rankedDetails(q, kind, items);
  if (!details.length) return `${rangeLabel}該当するデータの詳細は見つかりませんでした。名前やキーワードを少し具体的に入れてください。`;
  const labels: Record<string, string> = { expense: '支出', event: '予定', todo: 'ToDo', diary: '日記', anniversary: '記念日', memo: 'メモ' };
  const detailLines = details.slice(0, 5).map((item:any, index:number) => `${details.length > 1 ? `【${index + 1}】\n` : ''}${formatDetail(kind, item)}`).join('\n\n');
  return `${rangeLabel}該当する${labels[kind] || 'データ'}の詳細です。\n${detailLines}`;
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
  const s = scoped(body);
  const rangeLabel = s.range?.label ? `${s.range.label}の` : '';
  const matchedDetailIntent = detailIntent(q, intent, s);
  if (intent === 'out_of_scope' && !matchedDetailIntent) return 'このAIは登録された日記・予定・ToDo・支出・記念日・共有メモについて回答します。生活データに関する質問を入力してください。';
  const effectiveIntent = matchedDetailIntent || intent;

  if (effectiveIntent === 'expense') {
    if (matchedDetailIntent === 'expense') return detailAnswer(q, 'expense', filterExpenseCategory(q, s.expenses), rangeLabel);
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

  if (effectiveIntent === 'event') {
    if (matchedDetailIntent === 'event') return detailAnswer(q, 'event', s.events, rangeLabel);
    const events = s.events.sort((a:any, b:any) => String(a.startAt || '').localeCompare(String(b.startAt || '')));
    const lines = events.slice(0, 20).map((e:any)=>`・${formatDateTime(e.startAt)} ${e.title || '予定'}${e.location ? ` @${e.location}` : ''}（${e.ownerName || '不明'}${e.spaceName ? ` / ${e.spaceName}` : ''}）`).join('\n');
    return lines ? `${rangeLabel}予定は ${events.length}件あります。\n${lines}` : `${rangeLabel}参照可能な予定はありません。`;
  }

  if (effectiveIntent === 'todo') {
    const wantsDone = /完了済み|完了した/.test(q);
    const wantsOpen = /未完了|残って|残り|まだ|これから/.test(q);
    const detail = todoDetailRequested(q) || matchedDetailIntent === 'todo';
    const todoPool = s.todos.filter((t:any) => {
      if (wantsDone) return t.status === 'done';
      if (wantsOpen || !detail) return t.status !== 'done';
      return true;
    });
    const scoredTodos = todoPool
      .map((todo:any) => ({ todo, score: todoScore(q, todo) }))
      .filter((item:any) => !detail || item.score > 0)
      .sort((a:any, b:any) => {
        const priority = { high: 0, middle: 1, low: 2 } as Record<string, number>;
        return b.score - a.score || (priority[a.todo.priority] ?? 3) - (priority[b.todo.priority] ?? 3) || String(a.todo.dueAt || '').localeCompare(String(b.todo.dueAt || ''));
      });
    const todos = scoredTodos.map((item:any) => item.todo);
    if (detail) {
      if (!todos.length) return `${rangeLabel}該当するToDoの詳細は見つかりませんでした。ToDo名やキーワードを少し具体的に入れてください。`;
      const detailLines = todos.slice(0, 5).map((todo:any, index:number) => `${todos.length > 1 ? `【${index + 1}】\n` : ''}${formatTodoDetail(todo)}`).join('\n\n');
      return `${rangeLabel}該当するToDoの詳細です。\n${detailLines}`;
    }
    const lines = todos.slice(0, 20).map((t:any)=>`・${t.title}${t.description ? `: ${t.description}` : ''}${t.dueAt ? ` 期限:${t.dueAt}` : ''} 優先度:${priorityLabel[t.priority] || t.priority || '-'}${t.reminderEnabled && t.remindAt ? ` リマインド:${formatDateTime(t.remindAt)}` : ''}（${t.ownerName || '不明'}${t.spaceName ? ` / ${t.spaceName}` : ''}）`).join('\n');
    return lines ? `${rangeLabel}${wantsDone ? '完了済み' : '未完了'}ToDoは ${todos.length}件あります。\n${lines}` : `${rangeLabel}${wantsDone ? '完了済み' : '未完了'}ToDoはありません。`;
  }

  if (effectiveIntent === 'anniversary') {
    if (matchedDetailIntent === 'anniversary') return detailAnswer(q, 'anniversary', s.anniversaries, rangeLabel);
    const anniversaries = (s.anniversaries || []).sort((a:any, b:any) => String(a.date || '').localeCompare(String(b.date || '')));
    const lines = anniversaries.map((a:any)=>`・${a.date} ${a.title}${a.repeat === 'yearly' ? '（毎年）' : ''}`).join('\n');
    return lines || '登録済みの記念日はありません。';
  }

  if (effectiveIntent === 'memo') {
    if (matchedDetailIntent === 'memo') return detailAnswer(q, 'memo', s.sharedNotes, rangeLabel);
    const lines = (s.sharedNotes || []).map((n:any)=>`・${n.title}: ${n.content}`).join('\n');
    return lines || '共有メモはありません。';
  }

  if (effectiveIntent === 'diary' && matchedDetailIntent === 'diary') return detailAnswer(q, 'diary', s.diaries, rangeLabel);

  return null;
}

function keywordScoreForMemory(question: string, plan: SearchPlan | undefined, memory: any) {
  const hints = Array.from(new Set([...(plan?.keywords || []), ...detailHints(question)].map(compactText).filter(Boolean)));
  if (!hints.length) return 0;
  const text = compactText([memory.title, memory.contentText, memory.ownerName, memory.spaceName, memory.date, memory.sourceType].filter(Boolean).join(' '));
  return hints.reduce((score, hint) => score + (text.includes(hint) ? Math.min(8, hint.length) : 0), 0);
}
function sourceTypeMatchesPlan(plan: SearchPlan | undefined, sourceType: string) {
  if (!plan?.sourceTypes?.length) return true;
  return plan.sourceTypes.includes(sourceType);
}
async function searchRagMemory(body: Body, plan?: SearchPlan) {
  if (!body.groupId || !process.env.OPENAI_API_KEY) return { results: [] as any[], unavailable: true };
  try {
    const searchQuestion = plan?.contextualizedQuestion || body.question;
    const qEmbedding = await embedText([searchQuestion, ...(plan?.keywords || [])].filter(Boolean).join('\n'));
    const targetSpaceIds = Array.from(new Set((body.spaceIds?.length ? body.spaceIds : [body.groupId]).filter(Boolean))).slice(0, 30);
    const snaps = await Promise.all(targetSpaceIds.map(spaceId => adminDb().collection('aiMemory').where('groupId', '==', spaceId).get()));
    const wantsAll = plan?.ownerHint === 'all' || wantsAllOwners(searchQuestion);
    const wantsPartner = plan?.ownerHint === 'partner' || wantsPartnerOwner(searchQuestion, body.partnerName, body.partnerRelationship);
    const wantsSelf = plan?.ownerHint === 'self' || wantsSelfOwner(searchQuestion);
    const memberIds = mentionedMemberIds(searchQuestion, body.data?.members || []);
    const hints = Array.from(searchQuestion.matchAll(/([一-龥ぁ-んァ-ヶA-Za-z0-9]+)の/g)).map(match => match[1]).filter(Boolean);
    const mentionedSpaces = Array.from(new Set(snaps.flatMap(snap => snap.docs.map(d => String(d.data().spaceName || ''))).filter(name => name && (searchQuestion.includes(name) || hints.some(hint => name.includes(hint) || hint.includes(name))))));
    const candidates = snaps.flatMap(snap => snap.docs.map(d => ({ id: d.id, ...d.data() } as any))).filter((m:any) => {
      if (m.aiReadable === false) return false;
      if (!sourceTypeMatchesPlan(plan, String(m.sourceType || ''))) return false;
      if (mentionedSpaces.length && !mentionedSpaces.includes(String(m.spaceName || ''))) return false;
      const isMine = m.userId === body.currentUserId;
      if (!isMine && m.visibility !== 'shared') return false;
      if (wantsAll) return true;
      if (memberIds.length) return memberIds.includes(String(m.userId || ''));
      if (m.ownerName && searchQuestion.includes(m.ownerName)) return true;
      if (wantsPartner) return !isMine;
      if (wantsSelf) return isMine;
      if (m.ownerName && /さん|くん|ちゃん/.test(searchQuestion)) return searchQuestion.includes(m.ownerName);
      return true;
    });
    const scored = candidates
      .filter((m:any) => Array.isArray(m.embedding))
      .map((m:any) => {
        const vectorScore = cosineSimilarity(qEmbedding, m.embedding);
        const keywordScore = keywordScoreForMemory(searchQuestion, plan, m);
        const sourceBoost = sourceTypeMatchesPlan(plan, String(m.sourceType || '')) && plan?.sourceTypes?.length ? 0.04 : 0;
        const score = vectorScore + Math.min(0.35, keywordScore / 40) + sourceBoost;
        return { ...m, score, vectorScore, keywordScore };
      })
      .sort((a:any,b:any) => b.score - a.score || b.keywordScore - a.keywordScore || String(b.date || '').localeCompare(String(a.date || '')))
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
    const list = s.todos.filter((t:any)=>t.status!=='done').map((t:any)=>`・${t.title}${t.description ? `: ${t.description}` : ''}${t.dueAt ? ` 期限:${t.dueAt}` : ''}（${t.ownerName || '不明'}）`).join('\n');
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
  if (!process.env.OPENAI_API_KEY) return Response.json({ answer: fallbackAnswer(body), fallback: true });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const plan = await buildSearchPlan(client, body);
  const plannedBody = { ...body, question: plan.contextualizedQuestion || body.question };
  const intent = plan.intent !== 'unknown' ? plan.intent : classifyQuestion(plannedBody.question || '');
  const filtered = scoped(plannedBody);
  const exactAnswer = deterministicAnswer(plannedBody);
  if (exactAnswer) return Response.json({ answer: exactAnswer, deterministic: true, intent, plan });
  const rag = await searchRagMemory(plannedBody, plan);
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
      { role: 'system', content: `あなたはAI生活管理アプリのAIです。日記・予定・ToDo・支出・記念日・共有メモだけを根拠に日本語で回答します。今日=${new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}。相手の名前=${body.partnerName || '未設定'}。相手との関係性=${body.partnerRelationship || '未設定'}。分類済み意図=${intent}。入力データ以外を推測しない。質問計画のcontextualizedQuestionとkeywordsを優先して、会話中の「それ」「さっきの」などを解決する。支出はamountBase(JPY)で計算し、必要なら内訳を示す。詳細質問では各種類の詳細項目を必ず確認する。日記はtitle/content/mood/tags/date、予定はtitle/description/location/startAt/endAt/remindAt、ToDoはtitle/description/dueAt/priority/status/remindAt、支出はtitle/shopName/memo/category/amount/amountBase/currency/paymentMethod/receiptItems、記念日はtitle/date/repeat/remindDaysBefore、メモはtitle/contentを具体的に答える。相手の名前・関係性・メンバーのaliases/relationshipLabelsで質問された場合は該当メンバーのデータとして扱う。intent=diary または曖昧な思い出検索・感情・キーワード検索ではRAG結果を優先し、日付や金額の厳密集計は構造化データを優先する。intent=out_of_scopeなら生活データに関する質問だけ回答できると伝える。` },
      { role: 'user', content: `会話履歴(JSON):
${JSON.stringify((body.chatHistory || []).slice(-8))}

元の質問: ${body.question}
質問計画(JSON):
${JSON.stringify(plan)}

期間推定: ${filtered.range ? `${iso(filtered.range.start)}〜${iso(filtered.range.end)}` : '指定なし'}

RAG類似検索結果(JSON):
${JSON.stringify(ragContext)}

構造化データ(JSON):
${JSON.stringify(compactData)}` }
    ]
  });
  return Response.json({ answer: response.output_text, intent, plan, ragUsed: rag.results.length > 0, ragCount: rag.results.length, ragUnavailable: rag.unavailable });
}
