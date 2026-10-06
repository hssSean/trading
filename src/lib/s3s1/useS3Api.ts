'use client';
// 前端讀 /api/s3/*：帶 Supabase JWT；有 intervalMs 時只在頁面可見時輪詢。
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export function useS3Api<T extends { ok: boolean; reason?: string }>(path: string, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const jwt = session?.access_token ?? '';
      if (!jwt) { setError('尚未登入，無法查詢'); return; }
      const res = await fetch(path, { headers: { Authorization: `Bearer ${jwt}` }, cache: 'no-store' });
      const json = await res.json() as T;
      if (!res.ok || !json.ok) setError(json.reason ?? `查詢失敗（${res.status}）`);
      else { setData(json); setError(''); }
    } catch (e) {
      setError(String(e).slice(0, 150));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    load();
    if (!intervalMs) return;
    const id = setInterval(() => { if (document.visibilityState === 'visible') load(); }, intervalMs);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [load, intervalMs]);

  return { data, error, loading, reload: load };
}
