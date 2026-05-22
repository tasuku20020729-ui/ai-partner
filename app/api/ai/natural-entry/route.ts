import OpenAI from 'openai';

const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const today = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
const iso = (d: Date) => d.toISOString().slice(0, 10);
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
function categoryFromText(text: string) {
  if (/ランチ|夕食|朝食|ご飯|スーパー|食品|カフェ|食/.test(text)) return 'food';
  if (/日用品|洗剤|ティッシュ|雑貨/.test(text)) return 'daily_goods';
  if (/デート|交際|プレゼント/.test(text)) return 'dating';
  if (/電車|バス|タクシー|Grab|交通/.test(text)) return 'transport';
  if (/旅行|ホテル|航空券/.test(text)) return 'travel';
  if (/病院|薬|医療/.test(text)) return 'medical';
  if (/映画|ゲーム|娯楽|ライブ/.test(text)) return 'entertainment';
  return 'other';
}
function fallback(text: string) {
  const date = dateFromText(text);
  const amount = text.match(/(\d+[,.]?\d*)\s*(円|JPY|ドル|USD|リンギット|MYR)/i);
  if (amount) return { type: 'expense', title: text.replace(amount[0], '').slice(0, 30) || '支出', amount: Number(amount[1].replace(',', '')), currency: /ドル|USD/i.test(amount[2]) ? 'USD' : /リンギット|MYR/i.test(amount[2]) ? 'MYR' : 'JPY', date, category: categoryFromText(text), memo: text };
  const isTodo = /todo|ToDo|やる|課題|提出|買う|準備|する|確認|支払/.test(text) && !/(時|予定|集合|会議|食事|予約|行く)/.test(text);
  if (isTodo) return { type: 'todo', title: text.replace(/(を|する|やる|追加して|登録して)/g, '').slice(0, 40), dueAt: date, priority: /重要|急ぎ|高/.test(text) ? 'high' : 'middle', status: 'open', description: text };
  return { type: 'event', title: text.replace(/予定|追加して|登録して/g, '').slice(0, 40), startAt: `${date}T${timeFromText(text)}`, description: text };
}

export async function POST(req: Request) {
  const { text } = await req.json();
  if (!process.env.OPENAI_API_KEY) return Response.json({ entry: fallback(text || '') });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.responses.create({
    model,
    input: [{ role: 'system', content: `日本語の自然文を生活管理アプリ用JSONに変換します。現在日は${new Date().toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'})}。typeはevent/todo/expenseのいずれか。eventはtitle,startAt,endAt?,location?,description?。todoはtitle,dueAt?,priority,status,description?。expenseはtitle,date,amount,currency,category,memo?。categoryはfood/daily_goods/dating/transport/travel/medical/entertainment/other。JSONのみ返す。` }, { role: 'user', content: text || '' }]
  });
  try { return Response.json({ entry: JSON.parse(res.output_text) }); } catch { return Response.json({ entry: fallback(text || '') }); }
}
