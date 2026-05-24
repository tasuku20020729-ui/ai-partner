import { NextRequest, NextResponse } from "next/server";
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb, adminMessaging } from "@/lib/firebaseAdmin";
import { requireAuth } from "@/lib/serverAuth";

type PushTokenDoc = {
  token?: string;
  userId?: string;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const { title, body, url = "/", userId } = await req.json();

    if (!title || !body) {
      return NextResponse.json(
        { ok: false, error: "title and body are required" },
        { status: 400 }
      );
    }

    const targetUserId = userId ? String(userId) : auth.uid;
    if (targetUserId !== auth.uid) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    let q: FirebaseFirestore.Query = adminDb().collection("pushTokens");

    q = q.where("userId", "==", targetUserId);

    const snap = await q.get();

    const tokens = Array.from(
      new Set(
        snap.docs
          .map((d: QueryDocumentSnapshot) => {
            const data = d.data() as PushTokenDoc;
            return data.token;
          })
          .filter((token): token is string => Boolean(token))
      )
    );

    if (!tokens.length) {
      return NextResponse.json({ ok: true, sent: 0 });
    }

    const res = await adminMessaging().sendEachForMulticast({
      tokens,
      notification: {
        title: String(title),
        body: String(body),
      },
      data: {
        title: String(title),
        body: String(body),
        url: String(url),
      },
    });

    return NextResponse.json({
      ok: true,
      sent: res.successCount,
      failed: res.failureCount,
    });
  } catch (error: any) {
    console.error(error);

    return NextResponse.json(
      {
        ok: false,
        error: error?.message === "unauthorized" ? "unauthorized" : error?.message || "push send error",
      },
      { status: error?.message === "unauthorized" ? 401 : 500 }
    );
  }
}
