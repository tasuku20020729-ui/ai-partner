import { NextRequest, NextResponse } from 'next/server';
import { adminDb, adminMessaging } from '@/lib/firebaseAdmin';

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const db = adminDb();
  const now = Date.now();
  const soon = now + 10 * 60 * 1000;
  const jobs: { groupId: string; key: string; title: string; body: string }[] = [];

  const [todos, events, anniversaries] = await Promise.all([
    db.collection('todos').where('status', '==', 'open').get(),
    db.collection('events').get(),
    db.collection('anniversaries').get()
  ]);

  todos.docs.forEach(d => {
    const v = d.data();
    const at = Date.parse(v.remindAt || (v.dueAt ? `${v.dueAt}T09:00:00+09:00` : ''));
    if (v.reminderEnabled && at >= now && at <= soon) jobs.push({ groupId: v.groupId, key: `todo_${d.id}_${at}`, title: 'ToDoリマインド', body: v.title });
  });
  events.docs.forEach(d => {
    const v = d.data();
    const at = Date.parse(v.remindAt || v.startAt || '');
    if (v.reminderEnabled && at >= now && at <= soon) jobs.push({ groupId: v.groupId, key: `event_${d.id}_${at}`, title: '予定リマインド', body: v.title });
  });
  anniversaries.docs.forEach(d => {
    const v = d.data();
    const date = String(v.date || '').slice(5);
    const today = new Date();
    const target = new Date(`${today.getFullYear()}-${date}T09:00:00+09:00`).getTime();
    if (target >= now && target <= soon) jobs.push({ groupId: v.groupId, key: `anniv_${d.id}_${today.getFullYear()}`, title: '記念日リマインド', body: v.title });
  });

  let sent = 0;
  for (const job of jobs) {
    const already = await db.collection('sentNotifications').doc(job.key).get();
    if (already.exists) continue;
    const tokenSnap = await db.collection('pushTokens').where('groupId', '==', job.groupId).get();
    const tokens = [...new Set(tokenSnap.docs.map(d => d.data().token).filter(Boolean))];
    if (tokens.length) {
      const res = await adminMessaging().sendEachForMulticast({ tokens, notification: { title: job.title, body: job.body }, data: { title: job.title, body: job.body, url: '/' } });
      sent += res.successCount;
    }
    await db.collection('sentNotifications').doc(job.key).set({ ...job, sentAt: new Date().toISOString() });
  }
  return NextResponse.json({ ok: true, jobs: jobs.length, sent });
}
