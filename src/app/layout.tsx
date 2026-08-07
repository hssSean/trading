import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/BottomNav';
import { StoreHydration } from '@/components/StoreHydration';
import { PriceFeed } from '@/components/PriceFeed';

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
        {/* 2026-08-07：原本指向 /icon-192.png，但那個檔案從專案建立以來就
            沒被加入過（public/ 完全沒有點陣圖），這個 link 一直是 404。
            iOS 的 apple-touch-icon 規格不支援 SVG，沒辦法用 public/icon.svg
            頂替——拿掉死連結，iOS 沒讀到這個標籤時會退回用截圖當圖示，
            至少不會一直打一個註定失敗的請求。待補：真正的 PNG icon。 */}
      </head>
      <body className="bg-[#0A0D11] min-h-dvh" suppressHydrationWarning>
        <div className="max-w-xl mx-auto flex flex-col min-h-dvh">
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
