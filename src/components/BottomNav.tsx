'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Radar, ClipboardList, Activity, Settings } from 'lucide-react';
import { useStore } from '@/store/useStore';

const NAV = [
  { href: '/', label: '首頁', Icon: Home },
  { href: '/signals', label: '信號', Icon: Radar },
  { href: '/trades', label: '紀錄', Icon: ClipboardList },
  { href: '/health-check', label: '體檢', Icon: Activity },
  { href: '/settings', label: '設定', Icon: Settings },
];

export function BottomNav() {
  const pathname = usePathname();
  const unread        = useStore((s) => s.allSignals.filter((sg) => !sg.isRead).length);
  const pendingTrades = useStore((s) => s.trades.filter((t) => !t.result).length);

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-[#12161C] border-t border-[#222A35] flex safe-bottom z-50">
      {NAV.map(({ href, label, Icon }) => {
        const active   = href === '/' ? pathname === '/' || pathname.startsWith('/analysis') : pathname.startsWith(href);
        const badge    = href === '/signals' ? unread : href === '/trades' ? pendingTrades : 0;
        const badgeCls = href === '/signals' ? 'bg-[#F6465D] text-white' : 'bg-[#2DD4BF] text-[#08110F]';
        return (
          <Link
            key={href}
            href={href}
            className="flex-1 flex flex-col items-center justify-center pt-2.5 pb-1 gap-1"
          >
            <span className="relative">
              <Icon size={21} strokeWidth={1.75} color={active ? '#2DD4BF' : '#59616E'} />
              {badge > 0 && (
                <span className={`absolute -top-1.5 -right-2.5 ${badgeCls} text-[9px] font-medium rounded-full min-w-[15px] h-[15px] flex items-center justify-center px-[3px] num`}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
            <span className={`text-[11px] ${active ? 'text-[#2DD4BF] font-medium' : 'text-[#59616E]'}`}>
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
