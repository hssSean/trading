'use client';
// 整頁共用的動畫時鐘：requestAnimationFrame 節流到 fps，分頁隱藏時暫停；prefers-reduced-motion 時固定 0。
import { useEffect, useState } from 'react';

export function useTick(fps = 8): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    let last = 0, id = 0;
    const loop = (now: number) => {
      id = requestAnimationFrame(loop);
      if (document.hidden || now - last < 1000 / fps) return;
      last = now;
      setT((now - start) / 1000);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [fps]);
  return t;
}
