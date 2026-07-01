import type { Metadata, Viewport } from 'next';
import './globals.css';
import { BottomNav } from '@/components/BottomNav';
import { StoreHydration } from '@/components/StoreHydration';

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
  themeColor: '#0A0A0F',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-touch-fullscreen" content="yes" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body className="bg-[#0A0A0F] min-h-dvh" suppressHydrationWarning>
        <div className="max-w-xl mx-auto flex flex-col min-h-dvh">
          <StoreHydration>
            <main className="flex-1 pb-20">{children}</main>
            <BottomNav />
          </StoreHydration>
        </div>
      </body>
    </html>
  );
}
