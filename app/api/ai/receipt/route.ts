import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { receiptBodySchema, validationError } from "@/lib/apiSchemas";
import { todayIso } from "@/lib/date";
import { requireAuth } from "@/lib/serverAuth";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

function normalizeReceiptExpense(expense: any) {
  if (!expense || typeof expense !== "object") return null;
  const date = typeof expense.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expense.date)
    ? expense.date
    : todayIso();
  return { ...expense, date };
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req);
    const { imageUrl } = receiptBodySchema.parse(await req.json());

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
      text: {
        format: {
          type: "json_schema",
          name: "receipt_expense",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              shopName: { type: "string" },
              amount: { type: "number" },
              currency: { type: "string", enum: ["JPY", "MYR", "USD"] },
              date: { type: "string" },
              category: { type: "string", enum: ["food", "daily_goods", "dating", "transport", "travel", "medical", "entertainment", "other"] },
            },
            required: ["shopName", "amount", "currency", "date", "category"],
          },
        },
      },
    });

    const text =
      response.output_text ||
      JSON.stringify(response.output ?? {});

    let expense = null;
    try {
      expense = JSON.parse(text);
    } catch {
      expense = null;
    }

    return NextResponse.json({ success: true, expense: normalizeReceiptExpense(expense), result: text });
  } catch (error: any) {
    console.error(error);
    const invalid = validationError(error);
    if (invalid) return invalid;

    return NextResponse.json(
      {
        success: false,
        error: error?.message || "receipt parse error",
      },
      { status: error?.message === "unauthorized" ? 401 : 500 }
    );
  }
}
