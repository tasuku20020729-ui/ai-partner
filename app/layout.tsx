import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Life Diary',
  description: 'AI対応の日記・予定・ToDo・支出管理アプリ',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'AI Life Diary', statusBarStyle: 'default' },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f7f7fb'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
