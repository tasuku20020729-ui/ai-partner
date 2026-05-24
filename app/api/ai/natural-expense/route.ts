import OpenAI from 'openai';
import { textBodySchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

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
  const amountMatch = text.match(/(\d+[,.]?\d*)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(',', '')) : 0;
  const currency = text.includes('リンギット') || /MYR/i.test(text) ? 'MYR' : text.includes('ドル') || /USD/i.test(text) ? 'USD' : 'JPY';
  const category = categoryFromText(text);
  return { title: text.slice(0, 24) || '支出', amount, currency, category, date: new Date().toISOString().slice(0, 10), memo: text };
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
  if (!process.env.OPENAI_API_KEY) return Response.json({ expense: fallback(text || '') });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: `次の支出メモをJSONにしてください。カテゴリは food,daily_goods,dating,transport,travel,medical,entertainment,other のどれか。通貨は JPY,MYR,USD のどれか。今日の日付は${new Date().toISOString().slice(0,10)}。\n${text}`,
    text: {
      format: {
        type: 'json_schema',
        name: 'expense',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            shopName: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string', enum: ['JPY', 'MYR', 'USD'] },
            category: { type: 'string', enum: ['food', 'daily_goods', 'dating', 'transport', 'travel', 'medical', 'entertainment', 'other'] },
            date: { type: 'string' },
            memo: { type: 'string' }
          },
          required: ['title', 'shopName', 'amount', 'currency', 'category', 'date', 'memo']
        }
      }
    }
  });
  try { return Response.json({ expense: JSON.parse(res.output_text) }); }
  catch { return Response.json({ expense: fallback(text || '') }); }
}
