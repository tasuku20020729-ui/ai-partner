import OpenAI from 'openai';
import { textBodySchema, validationError } from '@/lib/apiSchemas';
import { requireAuth, unauthorized } from '@/lib/serverAuth';

function fallback(text: string) {
  const amountMatch = text.match(/(\d+[,.]?\d*)/);
  const amount = amountMatch ? Number(amountMatch[1].replace(',', '')) : 0;
  const currency = text.includes('リンギット') || /MYR/i.test(text) ? 'MYR' : text.includes('ドル') || /USD/i.test(text) ? 'USD' : 'JPY';
  const category = text.includes('ランチ') || text.includes('食') || text.includes('カフェ') ? 'food' : text.includes('電車') || text.includes('Grab') || text.includes('交通') ? 'transport' : text.includes('映画') || text.includes('デート') ? 'dating' : 'other';
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
