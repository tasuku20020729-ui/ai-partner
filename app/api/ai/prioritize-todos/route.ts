import OpenAI from 'openai';
import { todoPrioritizeSchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

type TodoInput = {
  id: string;
  title?: string;
  description?: string;
  dueAt?: string;
  priority?: 'low' | 'middle' | 'high';
  status?: 'open' | 'done';
  ownerName?: string;
  remindAt?: string;
  reminderEnabled?: boolean;
};
type EventInput = { id?: string; title?: string; startAt?: string; endAt?: string; location?: string };
type RankedTodo = { id: string; score: number; reason: string };

const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const DAY = 86400000;
const urgentWords = /急ぎ|至急|重要|今日|明日|締切|期限|提出|支払|支払い|予約|確認|連絡|申請|更新|準備|買う|購入|忘れ/;
const priorityScore: Record<string, number> = { high: 38, middle: 20, low: 8 };

function todayJst() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function parseDay(value?: string) {
  if (!value) return null;
  const text = value.slice(0, 10);
  const date = new Date(`${text}T00:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function daysUntil(value: string | undefined, today: string) {
  const target = parseDay(value);
  const base = parseDay(today);
  if (!target || !base) return null;
  return Math.round((target.getTime() - base.getTime()) / DAY);
}
function dueScore(diff: number | null) {
  if (diff === null) return 4;
  if (diff < 0) return 72;
  if (diff === 0) return 64;
  if (diff === 1) return 52;
  if (diff <= 3) return 36;
  if (diff <= 7) return 22;
  if (diff <= 14) return 12;
  return 6;
}
function dueReason(diff: number | null) {
  if (diff === null) return '期限未設定';
  if (diff < 0) return `期限を${Math.abs(diff)}日超過`;
  if (diff === 0) return '今日が期限';
  if (diff === 1) return '明日が期限';
  return `${diff}日後が期限`;
}
function relatedEventCount(events: EventInput[], todo: TodoInput) {
  const haystack = `${todo.title || ''} ${todo.description || ''}`;
  const tokens = haystack.match(/[一-龥ぁ-んァ-ヶA-Za-z0-9]{2,}/g) || [];
  if (!tokens.length) return 0;
  return events.filter(event => tokens.some(token => `${event.title || ''} ${event.location || ''}`.includes(token))).length;
}
function fallbackRank(todos: TodoInput[], events: EventInput[] = [], today = todayJst()): RankedTodo[] {
  return todos
    .filter(todo => todo.status !== 'done')
    .map(todo => {
      const diff = daysUntil(todo.dueAt, today);
      const text = `${todo.title || ''} ${todo.description || ''}`;
      const wordScore = urgentWords.test(text) ? 16 : 0;
      const reminder = todo.reminderEnabled && todo.remindAt ? 8 : 0;
      const eventLink = Math.min(relatedEventCount(events, todo) * 4, 12);
      const score = dueScore(diff) + (priorityScore[todo.priority || 'middle'] || 20) + wordScore + reminder + eventLink;
      const reasonParts = [
        dueReason(diff),
        `優先度${todo.priority === 'high' ? '高' : todo.priority === 'low' ? '低' : '中'}`,
        wordScore ? '重要語句あり' : '',
        eventLink ? '関連予定あり' : ''
      ].filter(Boolean);
      return { id: todo.id, score, reason: reasonParts.join(' / ') };
    })
    .sort((a, b) => b.score - a.score);
}
function parseAiItems(text: string, todos: TodoInput[], fallback: RankedTodo[]) {
  const ids = new Set(todos.map(todo => todo.id));
  const base = new Map(fallback.map(item => [item.id, item]));
  const jsonText = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = jsonText.indexOf('[');
  const end = jsonText.lastIndexOf(']');
  const parsed = JSON.parse(start >= 0 && end >= start ? jsonText.slice(start, end + 1) : jsonText) as unknown;
  if (!Array.isArray(parsed)) throw new Error('invalid_ai_json');
  const items = parsed
    .map((item: unknown): RankedTodo | null => {
      if (!item || typeof item !== 'object') return null;
      const value = item as { id?: unknown; score?: unknown; reason?: unknown };
      const id = String(value.id || '');
      if (!ids.has(id)) return null;
      const fallbackItem = base.get(id);
      return {
        id,
        score: Number(value.score || fallbackItem?.score || 0),
        reason: String(value.reason || fallbackItem?.reason || 'AIが重要度を判定しました').slice(0, 160)
      };
    })
    .filter((item): item is RankedTodo => Boolean(item));
  if (!items.length) throw new Error('empty_ai_json');
  const seen = new Set(items.map(item => item.id));
  const missing = fallback.filter(item => !seen.has(item.id));
  return [...items, ...missing].sort((a, b) => b.score - a.score);
}

export async function POST(req: Request) {
  try {
    await requireAuth(req);
  } catch {
    return unauthorized();
  }

  let body: { todos: TodoInput[]; events?: EventInput[]; today?: string };
  try {
    body = todoPrioritizeSchema.parse(await req.json());
  } catch (e) {
    const invalid = validationError(e);
    if (invalid) return invalid;
    throw e;
  }

  const today = body.today || todayJst();
  const baseline = fallbackRank(body.todos, body.events || [], today);
  if (!baseline.length) return Response.json({ items: [], fallback: true });
  if (!process.env.OPENAI_API_KEY) return Response.json({ items: baseline, fallback: true });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.responses.create({
      model,
      input: [
        {
          role: 'system',
          content: `あなたは生活管理アプリのToDo優先順位アシスタントです。今日の日付は${today}です。未完了ToDoを緊急度、期限、重要度、説明文、関連予定、実行順の自然さで整理してください。出力はJSON配列のみ。各要素は{id, score, reason}。scoreは0-100程度、reasonは日本語で短く。`
        },
        { role: 'user', content: JSON.stringify({ todos: body.todos.filter(todo => todo.status !== 'done'), events: body.events || [], baseline }) }
      ]
    });
    const items = parseAiItems(res.output_text || '[]', body.todos, baseline);
    return Response.json({ items, fallback: false });
  } catch {
    return Response.json({ items: baseline, fallback: true });
  }
}
