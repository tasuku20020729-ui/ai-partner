import OpenAI from 'openai';
import { textBodySchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const today = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const iso = (d: Date) => d.toISOString().slice(0, 10);
function jstDateTime(d: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d).reduce((acc: Record<string, string>, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function parseLocalDateTime(value: string) {
  return new Date(`${value.slice(0, 16)}:00+09:00`);
}
function dateFromText(text: string) {
  const now = today();
  if (/明後日/.test(text)) return iso(addDays(now, 2));
  if (/明日/.test(text)) return iso(addDays(now, 1));
  if (/昨日/.test(text)) return iso(addDays(now, -1));
  const m = text.match(/(\d{1,2})[\/月](\d{1,2})日?/);
  if (m) return `${now.getFullYear()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return iso(now);
}
function timeFromText(text: string) {
  const m = text.match(/(\d{1,2})[:時](\d{2})?/);
  if (!m) return '09:00';
  return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}
function notificationTimeFromText(text: string) {
  const after = text.match(/(?:通知|リマインド|教えて|知らせて|アラーム)[^\d]*(\d{1,2})[:時](\d{2})?/);
  const before = text.match(/(\d{1,2})[:時](\d{2})?[^\n]*(?:に|で)?(?:通知|リマインド|教えて|知らせて|アラーム)/);
  const m = after || before;
  if (m) return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
  if (/朝/.test(text)) return '09:00';
  if (/昼/.test(text)) return '12:00';
  if (/夕方/.test(text)) return '18:00';
  if (/夜/.test(text)) return '20:00';
  return '';
}
function reminderFromText(text: string, targetAt: string, fallbackDate: string) {
  if (!/(通知|リマインド|教えて|知らせて|アラーム)/.test(text)) return {};
  const target = parseLocalDateTime(targetAt || `${fallbackDate}T09:00`);
  const relative = text.match(/(\d{1,2})\s*(分|時間|日)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const offset = unit === '分' ? amount * 60000 : unit === '時間' ? amount * 3600000 : amount * 86400000;
    return { reminderEnabled: true, remindAt: jstDateTime(new Date(target.getTime() - offset)) };
  }
  if (/前日|前の日|前夜/.test(text)) {
    const time = notificationTimeFromText(text) || '09:00';
    return { reminderEnabled: true, remindAt: `${jstDateTime(addDays(target, -1)).slice(0, 10)}T${time}` };
  }
  const date = /当日|その日/.test(text) ? (targetAt || fallbackDate).slice(0, 10) : dateFromText(text);
  const time = notificationTimeFromText(text) || (targetAt ? targetAt.slice(11, 16) : '09:00');
  return { reminderEnabled: true, remindAt: `${date}T${time}` };
}
function recurrenceFromText(text: string) {
  if (/毎日|毎朝|毎晩/.test(text)) return 'daily';
  if (/毎週|毎週末|毎月曜|毎火曜|毎水曜|毎木曜|毎金曜|毎土曜|毎日曜/.test(text)) return 'weekly';
  if (/毎月|月次|家賃|サブスク|定期支出/.test(text)) return 'monthly';
  if (/毎年|年次/.test(text)) return 'yearly';
  return 'none';
}
function categoryFromText(text: string) {
  if (/ランチ|昼食|夕食|晩ごはん|朝食|ご飯|ごはん|スーパー|食品|食材|カフェ|喫茶|食|レストラン|居酒屋|コンビニ|セブン|ローソン|ファミマ|スタバ|マック|マクド|GrabFood|Uber Eats|出前/.test(text)) return 'food';
  if (/日用品|生活用品|洗剤|ティッシュ|トイレットペーパー|シャンプー|石鹸|せっけん|歯ブラシ|歯磨き|掃除|雑貨/.test(text)) return 'daily_goods';
  if (/デート|交際|プレゼント|ギフト|記念日|花|彼女|彼氏|パートナー/.test(text)) return 'dating';
  if (/電車|地下鉄|バス|タクシー|Grab|Uber|交通|駐車|高速|ガソリン|Suica|PASMO|切符|運賃/.test(text)) return 'transport';
  if (/旅行|ホテル|宿泊|航空券|飛行機|新幹線|旅館|Airbnb|観光|ツアー|レンタカー/.test(text)) return 'travel';
  if (/病院|薬|薬局|ドラッグストア|医療|診察|歯医者|クリニック|処方|サプリ|コンタクト/.test(text)) return 'medical';
  if (/映画|ゲーム|娯楽|ライブ|コンサート|イベント|本|漫画|サブスク|Netflix|Spotify|カラオケ|チケット/.test(text)) return 'entertainment';
  return 'other';
}
function fallback(text: string) {
  const date = dateFromText(text);
  const amount = text.match(/(\d+[,.]?\d*)\s*(円|JPY|ドル|USD|リンギット|MYR)/i);
  if (amount) return { type: 'expense', title: text.replace(amount[0], '').slice(0, 30) || '支出', amount: Number(amount[1].replace(',', '')), currency: /ドル|USD/i.test(amount[2]) ? 'USD' : /リンギット|MYR/i.test(amount[2]) ? 'MYR' : 'JPY', date, category: categoryFromText(text), memo: text, recurrence: recurrenceFromText(text) };
  const isTodo = /todo|ToDo|やる|課題|提出|買う|準備|する|確認|支払/.test(text) && !/(時|予定|集合|会議|食事|予約|行く)/.test(text);
  if (isTodo) {
    const dueAt = date;
    return { type: 'todo', title: text.replace(/(を|する|やる|追加して|登録して|通知|リマインド|教えて|知らせて)/g, '').slice(0, 40), dueAt, priority: /重要|急ぎ|高/.test(text) ? 'high' : 'middle', status: 'open', description: text, ...reminderFromText(text, `${dueAt}T09:00`, dueAt) };
  }
  const startAt = `${date}T${timeFromText(text)}`;
  return { type: 'event', title: text.replace(/予定|追加して|登録して|通知|リマインド|教えて|知らせて/g, '').slice(0, 40), startAt, description: text, recurrence: recurrenceFromText(text), ...reminderFromText(text, startAt, date) };
}

export async function POST(req: Request) {
  try {
    await requireAuth(req);
  } catch {
    return unauthorized();
  }
  let text = '';
  try {
    text = textBodySchema.parse(await req.json()).text;
  } catch (e) {
    const invalid = validationError(e);
    if (invalid) return invalid;
    throw e;
  }
  if (!process.env.OPENAI_API_KEY) return Response.json({ entry: fallback(text || '') });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.responses.create({
    model,
    input: [{ role: 'system', content: `日本語の自然文を生活管理アプリ用JSONに変換します。現在日は${new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}。typeはevent/todo/expenseのいずれか。eventはtitle,startAt,endAt?,location?,description?,reminderEnabled?,remindAt?,recurrence?,recurrenceEndAt?。todoはtitle,dueAt?,priority,status,description?,reminderEnabled?,remindAt?。expenseはtitle,date,amount,currency,category,memo?,recurrence?,recurrenceEndAt?。recurrenceはnone/daily/weekly/monthly/yearly。「毎日」「毎週」「毎月」「毎年」「家賃」「サブスク」などがあればevent/expenseにrecurrenceを入れる。categoryはfood/daily_goods/dating/transport/travel/medical/entertainment/other。「通知」「リマインド」「教えて」「知らせて」「1時間前」「30分前」「前日9時」などがあればevent/todoにreminderEnabled=trueとremindAt(Asia/TokyoのYYYY-MM-DDTHH:mm)を入れる。JSONのみ返す。` }, { role: 'user', content: text || '' }]
  });
  try {
    const entry = JSON.parse(res.output_text);
    if ((entry.type === 'event' || entry.type === 'expense') && !entry.recurrence) entry.recurrence = recurrenceFromText(text || '');
    if ((entry.type === 'event' || entry.type === 'todo') && (!entry.reminderEnabled || !entry.remindAt)) {
      const targetAt = entry.type === 'event' ? entry.startAt : `${entry.dueAt || dateFromText(text)}T09:00`;
      Object.assign(entry, reminderFromText(text || '', targetAt, (entry.dueAt || entry.startAt || dateFromText(text)).slice(0, 10)));
    }
    return Response.json({ entry });
  } catch { return Response.json({ entry: fallback(text || '') }); }
}
