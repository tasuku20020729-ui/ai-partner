"use client";

import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";

import { auth, db } from "@/lib/firebase";

type ChatMessage = {
  role: "user" | "ai";
  content: string;
};

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [saving, setSaving] = useState(false);

  const [partnerName, setPartnerName] = useState("");
  const [groupId, setGroupId] = useState("");

  const [visible, setVisible] = useState<any[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);

      if (u) {
        await loadVisibleData(u.uid);
      }

      setLoading(false);
    });

    return () => unsub();
  }, []);

  const loadVisibleData = async (uid: string) => {
    try {
      const q = query(
        collection(db, "diaries"),
        orderBy("createdAt", "desc")
      );

      const snap = await getDocs(q);

      const items = snap.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      setVisible(items);
    } catch (e) {
      console.error(e);
    }
  };

  const askAi = async () => {
    if (!user) return;
    if (!question.trim()) return;

    const q = question.trim();

    setQuestion("");

    setChat((c) => [
      ...c,
      {
        role: "user",
        content: q,
      },
    ]);

    setSaving(true);

    try {
      const res = await fetch("/api/ai/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: q,
          partnerName,
          currentUserId: user.uid,
          groupId,
          data: visible,
        }),
      });

      const json = await res.json();

      setChat((c) => [
        ...c,
        {
          role: "ai",
          content:
            json.answer || "回答を生成できませんでした。",
        },
      ]);
    } catch (e) {
      console.error(e);

      setChat((c) => [
        ...c,
        {
          role: "ai",
          content:
            "AI回答に失敗しました。OPENAI_API_KEYを確認してください。",
        },
      ]);
    } finally {
      setSaving(false);
    }
  };

  const createSampleDiary = async () => {
    if (!user) return;

    try {
      await addDoc(collection(db, "diaries"), {
        userId: user.uid,
        title: "サンプル日記",
        content: "今日はテスト投稿です。",
        visibility: "private",
        createdAt: serverTimestamp(),
      });

      await loadVisibleData(user.uid);
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-white text-black">
        Loading...
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-100 text-black p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="bg-white rounded-2xl shadow p-4">
          <h1 className="text-2xl font-bold mb-2">
            AI Life Diary
          </h1>

          {user ? (
            <p className="text-sm text-gray-600">
              ログイン中: {user.email}
            </p>
          ) : (
            <p className="text-sm text-red-500">
              ログインしてください
            </p>
          )}
        </div>

        <div className="bg-white rounded-2xl shadow p-4 space-y-3">
          <h2 className="font-semibold text-lg">
            AIチャット
          </h2>

          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {chat.map((m, i) => (
              <div
                key={i}
                className={`p-3 rounded-xl ${
                  m.role === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-gray-200 text-black"
                }`}
              >
                {m.content}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="先週何してた？"
              className="flex-1 border rounded-xl px-4 py-2"
            />

            <button
              onClick={askAi}
              disabled={saving}
              className="bg-black text-white px-4 py-2 rounded-xl"
            >
              {saving ? "送信中" : "送信"}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow p-4 space-y-3">
          <h2 className="font-semibold text-lg">
            サンプル日記
          </h2>

          <button
            onClick={createSampleDiary}
            className="bg-blue-500 text-white px-4 py-2 rounded-xl"
          >
            日記追加
          </button>

          <div className="space-y-2">
            {visible.map((item) => (
              <div
                key={item.id}
                className="border rounded-xl p-3 bg-gray-50"
              >
                <div className="font-semibold">
                  {item.title}
                </div>

                <div className="text-sm text-gray-600">
                  {item.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
