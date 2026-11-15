// 訊號頁的列表整理：同一個 S3 訊號（同幣、同一根日線）會同時出現在真倉與帳本 S3-A／S3-B，合併成一列。
export type SignalSrc = 'live' | 's3a' | 's3b' | 's1' | 'br';

export interface SignalItem {
  src: SignalSrc; symbol: string; t: number; decision: 'open' | 'skip'; reason?: string;
  close: number; stop: number; score?: number; parts?: number[]; dist?: number;
  legs?: Partial<Record<'A' | 'B', string>>;
}

export interface SignalRow extends SignalItem {
  /** 合併進來的其他來源（同一個 S3 訊號在帳本的決策） */
  also: { src: SignalSrc; decision: 'open' | 'skip'; reason?: string }[];
}

const S3_ORDER: SignalSrc[] = ['live', 's3a', 's3b'];

/** items 已依時間新到舊排好。S3 三個來源依 真倉 → 帳本 S3-A → 帳本 S3-B 的順序挑主列，其他併進 also；S1／BR 不合併。 */
export function mergeS3Rows(items: SignalItem[]): SignalRow[] {
  const rows: SignalRow[] = [];
  const byKey = new Map<string, SignalRow>();
  const sorted = [...items].sort((a, b) => b.t - a.t || S3_ORDER.indexOf(a.src) - S3_ORDER.indexOf(b.src));
  for (const it of sorted) {
    if (!S3_ORDER.includes(it.src)) { rows.push({ ...it, also: [] }); continue; }
    const key = `${it.symbol}|${it.t}`;
    const main = byKey.get(key);
    if (main) { main.also.push({ src: it.src, decision: it.decision, reason: it.reason }); continue; }
    const row: SignalRow = { ...it, also: [] };
    byKey.set(key, row);
    rows.push(row);
  }
  return rows;
}

/** 決策篩選：合併列裡任一來源符合就留下 */
export const rowMatches = (r: SignalRow, dec: 'all' | 'open' | 'skip') =>
  dec === 'all' || r.decision === dec || r.also.some(a => a.decision === dec);
