'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldPromptUpdate } from '@/lib/buildVersion';

// 偵測分頁跑在舊 bundle 上，跳一條橫幅讓使用者點一下重載。
// 為什麼需要這個東西，見 src/lib/buildVersion.ts 的檔頭。

// 打包時寫死（next.config.js 把 VERCEL_GIT_COMMIT_SHA 映射過來）。
// 注意：一定要寫成完整的 process.env.X 字面量，Next 才會在建置時做字串替換；
// 拆成變數取值會在瀏覽器變成 undefined。
const LOCAL_SHA = process.env.NEXT_PUBLIC_BUILD_SHA;

// 同一個分頁最多多久查一次。只在切回前景時查，所以正常一天也不會幾次；
// 這個節流是防「快速切來切去」把 Vercel 函數呼叫數打上去。
const MIN_INTERVAL_MS = 60_000;

export function VersionGate() {
  const [serverSha, setServerSha] = useState<string>();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lastCheckRef = useRef(0);

  const check = useCallback(async () => {
    if (!LOCAL_SHA) return;                                  // 本機開發，沒有 sha 可比
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastCheckRef.current < MIN_INTERVAL_MS) return;
    lastCheckRef.current = Date.now();
    try {
      const res = await fetch('/api/build', { cache: 'no-store' });
      if (!res.ok) return;
      const data: { sha?: string } = await res.json();
      setServerSha(data.sha);
    } catch {
      // 離線／函數冷啟失敗都不處理。取不到 sha 一律當作「沒有新版」，
      // 絕不因為查不到就跳更新提示（見 shouldPromptUpdate 的測試）。
    }
  }, []);

  useEffect(() => {
    void check();
    // 切回前景是最關鍵的時機——正好就是「App 在背景放了一天再打開」那一刻，
    // 也是最可能卡在舊版的時候。
    const onVis = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [check]);

  if (!shouldPromptUpdate({ local: LOCAL_SHA, server: serverSha, dismissed })) return null;

  return (
    <div className="sticky top-0 z-50 flex items-center gap-2 px-3 py-2 bg-[#12303A] border-b border-[#2DD4BF]/40">
      <span className="text-[#2DD4BF] text-[12px] flex-1">
        有新版本可用 —— 目前畫面跑的是舊程式碼
      </span>
      <button
        // 刻意不自動重載：重載會清掉未存的筆記編輯，也可能發生在你正盯著一筆
        // 持倉的時候。什麼時候中斷由使用者決定。
        onClick={() => window.location.reload()}
        className="text-[12px] px-3 py-1 rounded bg-[#2DD4BF] text-[#0A0D11] active:opacity-70"
      >
        更新
      </button>
      <button
        onClick={() => setDismissed(serverSha ?? null)}
        aria-label="稍後再說"
        className="text-[#8A94A2] text-[14px] px-1.5 active:opacity-70"
      >
        ×
      </button>
    </div>
  );
}
