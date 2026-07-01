'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useStore } from '@/store/useStore';

const NAV = [
  { href: '/', label: '首頁', icon: '🏠' },
  { href: '/signals', label: '信號', icon: '📊' },
  { href: '/settings', label: '設定', icon: '⚙️' },
];

export function BottomNav() {
  const pathname = usePathname();
  const unread = useStore((s) => s.allSignals.filter((sg) => !sg.isRead).length);

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-[#12121A] border-t border-[#1E1E2E] flex safe-bottom z-50">
      {NAV.map(({ href, label, icon }) => {
        const active = href === '/' ? pathname === '/' || pathname.startsWith('/analysis') : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex-1 flex flex-col items-center justify-center pt-3 pb-1 gap-1 transition-opacity ${active ? 'opacity-100' : 'opacity-40'}`}
          >
            <span className="text-xl relative">
              {icon}
              {href === '/signals' && unread > 0 && (
                <span className="absolute -top-1 -right-2 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-[3px]">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </span>
            <span className={`text-[10px] font-semibold ${active ? 'text-[#F0B90B]' : 'text-[#606080]'}`}>
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
