'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Radar, BookOpen, ClipboardList, Settings } from 'lucide-react';
import { useS3Store } from '@/store/useS3Store';

// 2026-10-07 起以 S3 策略為主（docs/superpowers/specs/2026-10-07-s3-app-redesign-design.md）。
// 舊策略的頁面（/legacy*、漏斗、歸因、體檢、個幣分析）從設定頁進入，歸在「設定」分頁底下。
const NAV = [
  { href: '/', label: '首頁', Icon: Home },
  { href: '/signals', label: '訊號', Icon: Radar },
  { href: '/ledgers', label: '帳本', Icon: BookOpen },
  { href: '/trades', label: '紀錄', Icon: ClipboardList },
  { href: '/settings', label: '設定', Icon: Settings },
];
const UNDER_SETTINGS = ['/settings', '/legacy', '/analysis', '/funnel', '/attribution', '/health-check'];

function isActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/settings') return UNDER_SETTINGS.some(p => pathname.startsWith(p));
  return pathname.startsWith(href);
}

export function BottomNav() {
  const pathname = usePathname();
  const todayOpens = useS3Store((s) => s.todayOpens);
  const openCount = useS3Store((s) => s.openCount);

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-[#0C1116] border-t border-white/[0.06] flex safe-bottom z-50">
      {NAV.map(({ href, label, Icon }) => {
        const active = isActive(href, pathname);
        const badge = href === '/signals' ? todayOpens : href === '/trades' ? openCount : 0;
        return (
          <Link key={href} href={href} className="flex-1 flex flex-col items-center justify-center pt-2.5 pb-1 gap-1">
            <span className="relative">
              <Icon size={21} strokeWidth={1.75} color={active ? '#2DD4BF' : '#59616E'} />
              {badge > 0 && (
                <span className="absolute -top-1.5 -right-2.5 bg-accent text-[#08110F] text-[9px] font-medium rounded-full min-w-[15px] h-[15px] flex items-center justify-center px-[3px] num">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span className={`text-[11px] ${active ? 'text-accent font-medium' : 'text-text-m'}`}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
