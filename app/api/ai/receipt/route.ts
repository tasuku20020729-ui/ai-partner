import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { imageUrl } = body;

    if (!imageUrl) {
      return NextResponse.json(
        { error: "imageUrl is required" },
        { status: 400 }
      );
    }

    const response = await openai.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
このレシート画像を解析してください。

以下のJSON形式のみで返してください。

{
  "shopName": "",
  "amount": 0,
  "currency": "JPY",
  "date": "",
  "category": "food"
}

category は以下から選択:
food
daily_goods
dating
transport
travel
medical
entertainment
other
              `,
            },
            {
              type: "input_image",
              image_url: String(imageUrl),
              detail: "auto",
            },
          ],
        },
      ],
    });

    const text =
      response.output_text ||
      JSON.stringify(response.output ?? {});

    return NextResponse.json({
      success: true,
      result: text,
    });
  } catch (error: any) {
    console.error(error);

    return NextResponse.json(
      {
        success: false,
        error: error?.message || "receipt parse error",
      },
      { status: 500 }
    );
  }
}