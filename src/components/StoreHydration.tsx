'use client';
// Renders a skeleton until the Zustand store has rehydrated from localStorage.
// This prevents the SSR/CSR mismatch that causes "亂碼" (garbled content).
import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';

export function StoreHydration({ children }: { children: React.ReactNode }) {
  const hasHydrated = useStore((s) => s._hasHydrated);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // During SSR and first paint, show a dark placeholder (avoids flash)
  if (!mounted || !hasHydrated) {
    return (
      <div className="min-h-dvh bg-[#0A0A0F] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
