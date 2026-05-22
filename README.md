# AI Life Diary v5

日記・予定・ToDo・支出・記念日・共有メモをAIで横断検索できる生活管理アプリです。
第5版では、Firestoreの構造化検索に加えて、OpenAI Embeddingsを使ったRAG意味検索を追加しています。

## 主な機能

- Firebase Authentication ログイン
- 日記、予定、ToDo、支出、記念日、共有メモ
- カップル共有ID
- レシートAI解析
- AI自然文登録
- PWA Push通知の土台
- 本格RAG用 `aiMemory` コレクション
- 新規登録データの自動Embedding化
- 既存データのRAG再同期ボタン

## セットアップ

```bash
npm install
npm run dev
```

`.env.local` に `.env.example` の値を設定してください。

## 追加されたRAG構成

保存時に以下のデータを `aiMemory` に同期します。

- diaries
- events
- todos
- expenses
- anniversaries
- sharedNotes

保存時またはAI画面の「RAGインデックスを再同期」ボタンで、OpenAI Embeddings APIを使ってベクトルを作成します。
AI質問時は、質問文もEmbedding化し、`aiMemory` の類似度上位データをAIに渡します。

## 必要な環境変数

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FIREBASE_CLIENT_EMAIL` と `FIREBASE_PRIVATE_KEY` は、RAG同期APIとPush通知送信APIで使います。

## RAGの使い方

1. 通常どおり日記・予定・ToDo・支出などを登録
2. 新規データは自動で `aiMemory` に同期
3. 既存データはAI画面の「RAGインデックスを再同期」を押す
4. 「前に雰囲気の良かったカフェどこだっけ？」のような曖昧検索が可能になります

## 注意

- 身内利用想定の簡易Security Rulesです。
- RAG同期にはOpenAI API料金が発生します。
- `aiMemory` は小規模利用向けにFirestoreから取得してアプリ側でcos類似度計算しています。大規模化する場合はFirestore Vector SearchやPineconeへの移行を推奨します。
