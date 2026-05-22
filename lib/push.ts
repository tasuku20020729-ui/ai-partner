'use client';

import { doc, setDoc } from 'firebase/firestore';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { app, db } from '@/lib/firebase';

export async function enablePwaPush(userId: string, groupId: string) {
  if (!('Notification' in window)) throw new Error('このブラウザは通知に対応していません。');
  const supported = await isSupported();
  if (!supported) throw new Error('この端末ではFirebase Messagingを利用できません。iPhoneの場合はホーム画面に追加したPWAから試してください。');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした。');

  const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' });
  const messaging = getMessaging(app);
  const vapidKey = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
  if (!vapidKey) throw new Error('NEXT_PUBLIC_FIREBASE_VAPID_KEY が未設定です。Firebase ConsoleでWeb Push証明書を作成してください。');
  const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error('Pushトークンを取得できませんでした。');

  await setDoc(doc(db, 'pushTokens', token), {
    token,
    userId,
    groupId,
    ua: navigator.userAgent,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, { merge: true });

  onMessage(messaging, payload => {
    const title = payload.notification?.title || payload.data?.title || 'AI Life Diary';
    const body = payload.notification?.body || payload.data?.body || '';
    if (Notification.permission === 'granted') new Notification(title, { body, icon: '/icon-192.png' });
  });

  return token;
}
