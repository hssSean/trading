'use client';
import { create } from 'zustand';

// 底部導覽的徽章（首頁載入 /api/s3/overview 時寫入）。不 persist：重新整理後等首頁再載一次即可。
interface S3NavState {
  todayOpens: number;   // 今天 S3-A 真倉開了幾筆（訊號分頁徽章）
  openCount: number;    // S3-A 真倉持倉數（紀錄分頁徽章）
  set: (p: Partial<Pick<S3NavState, 'todayOpens' | 'openCount'>>) => void;
}

export const useS3Store = create<S3NavState>()((set) => ({
  todayOpens: 0,
  openCount: 0,
  set: (p) => set(p),
}));
