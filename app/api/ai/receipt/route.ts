import OpenAI from 'openai';

export async function POST(req: Request) {
  const { imageUrl } = await req.json();
  if (!process.env.OPENAI_API_KEY) {
    return Response.json({ expense: { title: 'レシート支出', shopName: '', amount: 0, currency: 'JPY', category: 'other', date: new Date().toISOString().slice(0,10), memo: 'OPENAI_API_KEY未設定のため手動で修正してください。', receiptItems: [] } });
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    input: [
      { role: 'system', content: 'あなたはレシート画像から支出データを抽出するAIです。金額が不明な場合は0にしてください。' },
      { role: 'user', content: [
        { type: 'input_text', text: 'このレシートから店名、日付、合計金額、通貨、カテゴリ、主な品目を抽出してJSONで返してください。カテゴリは food,daily_goods,dating,transport,travel,medical,entertainment,other。' },
        { type: 'input_image', image_url: imageUrl }
      ] }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'receipt_expense',
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string' }, shopName: { type: 'string' }, amount: { type: 'number' },
            currency: { type: 'string', enum: ['JPY','MYR','USD'] },
            category: { type: 'string', enum: ['food','daily_goods','dating','transport','travel','medical','entertainment','other'] },
            date: { type: 'string' }, memo: { type: 'string' }, receiptItems: { type: 'array', items: { type: 'string' } }
          },
          required: ['title','shopName','amount','currency','category','date','memo','receiptItems']
        }
      }
    }
  });
  try { return Response.json({ expense: JSON.parse(res.output_text) }); }
  catch { return Response.json({ expense: { title: 'レシート支出', shopName: '', amount: 0, currency: 'JPY', category: 'other', date: new Date().toISOString().slice(0,10), memo: '解析結果を読み取れませんでした。', receiptItems: [] } }); }
}
