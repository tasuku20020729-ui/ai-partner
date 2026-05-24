import OpenAI from 'openai';
import { askBodySchema, validationError } from '@/lib/apiSchemas';
import { adminDb } from '@/lib/firebaseAdmin';
import { cosineSimilarity, embedText } from '@/lib/rag';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

type Body = { question: string; partnerName?: string; currentUserId?: string; groupId?: string; data: any };
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DAY = 86400000;
const today = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const yen = (n: number) => `${Math.round(n).toLocaleString()}円`;

function rangeFromQuestion(q: string) {
  const base = today();
  const start = new Date(base); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  if (/明後日/.test(q)) { start.setDate(start.getDate() + 2); end.setDate(end.getDate() + 2); return { start, end, label: '明後日' }; }
  if (/明日/.test(q)) { start.setDate(start.getDate() + 1); end.setDate(end.getDate() + 1); return { start, end, label: '明日' }; }
  if (/今日/.test(q)) return { start, end, label: '今日' };
  if (/昨日/.test(q)) { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); return { start, end, label: '昨日' }; }
  if (/先週/.test(q)) { start.setDate(start.getDate() - 7); end.setTime(base.getTime()); return { start, end, label: '先週' }; }
  if (/来週/.test(q)) { start.setDate(start.getDate() + 7); end.setDate(start.getDate() + 7); return { start, end, label: '来週' }; }
  if (/今月/.test(q)) { start.setDate(1); end.setMonth(start.getMonth() + 1, 1); return { start, end, label: '今月' }; }
  if (/先月/.test(q)) { start.setMonth(start.getMonth() - 1, 1); end.setMonth(start.getMonth() + 1, 1); return { start, end, label: '先月' }; }
  if (/今週/.test(q)) { const day = start.getDay(); start.setDate(start.getDate() - day); end.setDate(start.getDate() + 7); return { start, end, label: '今週' }; }
  return null;
}
function inRange(dateText: string | undefined, range: ReturnType<typeof rangeFromQuestion>) {
  if (!dateText || !range) return true;
  const d = new Date(dateText); if (Number.isNaN(d.getTime())) return true;
  return d >= range.start && d < range.end;
}
function ownerMatch(item: any, q: string, partnerName?: string, currentUserId?: string) {
  if (/彼女|彼氏|相手|パートナー/.test(q) || (partnerName && q.includes(partnerName))) return item.userId !== currentUserId;
  if (/自分|私|俺|僕/.test(q)) return item.userId === currentUserId;
  return true;
}
function scoped(body: Body) {
  const q = body.question || '';
  const range = rangeFromQuestion(q);
  const data = body.data || {};
  return {
    range,
    diaries: (data.diaries || []).filter((d:any)=>inRange(d.date, range) && ownerMatch(d, q, body.partnerName, body.currentUserId)),
    events: (data.events || []).filter((e:any)=>inRange(e.startAt, range) && ownerMatch(e, q, body.partnerName, body.currentUserId)),
    todos: (data.todos || []).filter((t:any)=>inRange(t.dueAt || t.createdAt, range) && ownerMatch(t, q, body.partnerName, body.currentUserId)),
    expenses: (data.expenses || []).filter((e:any)=>inRange(e.date, range) && ownerMatch(e, q, body.partnerName, body.currentUserId)),
    anniversaries: data.anniversaries || [],
    sharedNotes: data.sharedNotes || []
  };
}
function sumExpenses(list: any[]) { return list.reduce((s, e) => s + Number(e.amountBase || e.amount || 0), 0); }

async function searchRagMemory(body: Body) {
  if (!body.groupId || !process.env.OPENAI_API_KEY) return { results: [] as any[], unavailable: true };
  try {
    const qEmbedding = await embedText(body.question);
    const snap = await adminDb().collection('aiMemory').where('groupId', '==', body.groupId).get();
    const wantsPartner = /彼女|彼氏|相手|パートナー/.test(body.question) || Boolean(body.partnerName && body.question.includes(body.partnerName));
    const wantsSelf = /自分|私|俺|僕/.test(body.question);
    const candidates = snap.docs.map(d => ({ id: d.id, ...d.data() } as any)).filter((m:any) => {
      if (m.aiReadable === false) return false;
      const isMine = m.userId === body.currentUserId;
      if (!isMine && m.visibility !== 'shared') return false;
      if (wantsPartner) return !isMine;
      if (wantsSelf) return isMine;
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
  const body = { ...rawBody, currentUserId: auth.uid, groupId: auth.groupId };
  const filtered = scoped(body);
  if (!process.env.OPENAI_API_KEY) return Response.json({ answer: fallbackAnswer(body), fallback: true });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const rag = await searchRagMemory(body);
  const compactData = {
    diaries: filtered.diaries.slice(0, 60),
    events: filtered.events.slice(0, 100),
    todos: filtered.todos.slice(0, 100),
    expenses: filtered.expenses.slice(0, 160),
    anniversaries: filtered.anniversaries.slice(0, 50),
    sharedNotes: filtered.sharedNotes.slice(0, 50)
  };
  const ragContext = rag.results.map((m:any, i:number) => ({
    rank: i + 1,
    score: Number(m.score || 0).toFixed(3),
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    ownerName: m.ownerName,
    date: m.date,
    title: m.title,
    text: m.contentText
  }));
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: `あなたはAI生活管理アプリのAIです。日記・予定・ToDo・支出・記念日・共有メモだけを根拠に日本語で回答します。今日=${new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}。相手の呼び名=${body.partnerName || '彼女/彼氏'}。入力データ以外を推測しない。支出はamountBase(JPY)で計算し、必要なら内訳を示す。RAG類似検索結果がある場合は、曖昧な思い出検索・場所・感情・キーワード検索ではRAG結果を優先し、日付や金額の厳密集計は構造化データを優先する。` },
      { role: 'user', content: `質問: ${body.question}

期間推定: ${filtered.range ? `${iso(filtered.range.start)}〜${iso(filtered.range.end)}` : '指定なし'}

RAG類似検索結果(JSON):
${JSON.stringify(ragContext)}

構造化データ(JSON):
${JSON.stringify(compactData)}` }
    ]
  });
  return Response.json({ answer: response.output_text, ragUsed: rag.results.length > 0, ragCount: rag.results.length, ragUnavailable: rag.unavailable });
}
