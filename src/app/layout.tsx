import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/BottomNav';
import { StoreHydration } from '@/components/StoreHydration';
import { PriceFeed } from '@/components/PriceFeed';
import { VersionGate } from '@/components/VersionGate';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Crypto Trader',
  description: '加密貨幣交易信號分析 — SMC + SNR + RSI/MACD',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Crypto Trader',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0A0D11',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-touch-fullscreen" content="yes" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="bg-[#0A0D11] min-h-dvh" suppressHydrationWarning>
        <div className="max-w-xl mx-auto flex flex-col min-h-dvh">
          {/* 掛在 StoreHydration 外面：舊版偵測跟登入/資料載入無關，就算
              store 還在同步或同步失敗也該能提示更新。 */}
          <VersionGate />
          <StoreHydration>
            {/* Lives here, not in a page: price polling must survive navigation. */}
            <PriceFeed />
            <main className="flex-1 pb-20">{children}</main>
            <BottomNav />
          </StoreHydration>
        </div>
      </body>
    </html>
  );
}
