'use client';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[App Error]', error);
  }, [error]);

  return (
    <div className="min-h-dvh bg-[#0A0A0F] flex flex-col items-center justify-center px-8 text-center gap-6">
      <div className="text-5xl">⚠️</div>
      <div>
        <h2 className="text-[#EAEAF4] text-lg font-bold mb-2">發生錯誤</h2>
        <p className="text-[#606080] text-sm">{error.message || '頁面載入失敗，請重試'}</p>
      </div>
      <button
        onClick={reset}
        className="btn-primary px-8 py-3 rounded-2xl"
      >
        重新載入
      </button>
    </div>
  );
}
