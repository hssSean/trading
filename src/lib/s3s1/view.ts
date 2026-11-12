// App 畫面用的 S3 計算（首頁、紀錄頁）。純函數，有單元測試（tests/s3View.test.ts）。
import { LEGS, legMeta, type Leg } from '../../engine/s3aLive';
import { S3_TH, BREADTH_MAX } from './rules';
const DAY = 86_400_000;
const DECISION_OFFSET_MS = 30_000; // live-runner 在 UTC 00:00:30 之後做每日決策（s3aLive.ts）

/** live-runner 每 60 秒寫一次心跳；超過兩倍就當作沒在跑 */
export const HEARTBEAT_STALE_MS = 120_000;

/** 下一次 S3 每日決策的時間（UTC 00:00:30） */
export function nextDecisionAt(now: number): number {
  const today = Math.floor(now / DAY) * DAY + DECISION_OFFSET_MS;
  return now < today ? today : today + DAY;
}

/** 文件 §8 停用條件的進度（A：35%／7 筆；B：40%／15 筆）；回撤口徑與 stats.summarizeLive 相同 */
export function haltProgress(meta: Record<string, unknown>, leg: Leg = 'A') {
  const m = legMeta(meta, leg);
  return {
    ddPct: m.base > 0 ? (m.peak - m.realized) / (m.base + m.peak) * 100 : 0,
    ddLimit: LEGS[leg].DD * 100,
    streak: m.streak,
    streakLimit: LEGS[leg].STREAK,
    halted: m.halted,
  };
}

/**
 * 持倉的浮動 R（以初始風險 entry − stop0 為 1R）。
 * 已平 1/3 時：平掉那部分按 +1R 計（止盈價就是 entry + 1R），剩餘部分按現價計，依數量加權。
 */
export function unrealizedR(p: { entry: number; stop0: number; qty0: number; partial: boolean; tpQty: number }, price: number): number | null {
  const risk = p.entry - p.stop0;
  if (!(price > 0) || !(risk > 0)) return null;
  const r = (price - p.entry) / risk;
  if (!p.partial || !(p.qty0 > 0)) return r;
  const done = p.tpQty / p.qty0;
  return done * 1 + (1 - done) * r;
}

/**
 * 合併部位裡某個策略那一份的浮動 R（以該策略原單的初始風險為 1R）。
 * B 份另外加上加碼份的浮動損益（加碼價以觸發價 E＋1R 估）。沒有 legs 的舊紀錄 = 全部是 A。
 */
export function legUnrealizedR(
  p: { entry: number; stop0: number; qty0: number; partial: boolean; tpQty: number; legs?: Partial<Record<Leg, { qty0: number; tpQty: number }>>; addQty?: number; addFilled?: boolean },
  price: number, leg: Leg,
): number | null {
  const l = p.legs ? p.legs[leg] : leg === 'A' ? { qty0: p.qty0, tpQty: p.tpQty } : undefined;
  if (!l || !(l.qty0 > 0)) return null;
  const base = unrealizedR({ entry: p.entry, stop0: p.stop0, qty0: l.qty0, tpQty: l.tpQty, partial: p.partial }, price);
  if (base == null || leg !== 'B' || !p.addFilled || !(p.addQty! > 0)) return base;
  const r1 = p.entry - p.stop0;
  const addPnl = p.addQty! * (price - (p.entry + r1));
  return base + addPnl / (l.qty0 * r1);
}

export interface TodaySummary {
  X: number; ready: boolean; btcOk: boolean | null; breadth: number | null;
  candidates: number; opened: string[]; blocked: { symbol: string; reason: string }[];
}

/** 今天（決策日 X，訊號日 D = X − 1）的市場條件與真倉決策 */
export function todaySummary(
  snap: { X: number; breadth: number; btcOk: Record<string, boolean>; s3: { symbol: string }[] } | null,
  signals: { symbol: string; signalDay: number; decision: 'open' | 'skip'; reason?: string }[],
  now: number,
): TodaySummary {
  const X = Math.floor(now / DAY) * DAY;
  const D = X - DAY;
  const mine = signals.filter(s => s.signalDay === D);
  return {
    X,
    ready: !!snap && snap.X === X,
    btcOk: snap && snap.X === X ? !!snap.btcOk[String(D)] : null,
    breadth: snap && snap.X === X ? snap.breadth : null,
    candidates: snap && snap.X === X ? snap.s3.length : 0,
    opened: mine.filter(s => s.decision === 'open').map(s => s.symbol),
    blocked: mine.filter(s => s.decision === 'skip').map(s => ({ symbol: s.symbol, reason: s.reason ?? '' })),
  };
}

/**
 * 用白話說明「現在的市場狀態下 S3 會不會開倉」（首頁用）。2026-11-12：使用者連續五週沒單以為是故障，
 * 其實是 BTC 在 EMA50 之下——只做多的策略空頭期本來就不開倉。tone：bad = 不會開、warn = 很難開、ok = 會開。
 */
export function regimeNote(btcOk: boolean | null, btcExt: number | null | undefined, breadth: number | null): { tone: 'ok' | 'warn' | 'bad'; text: string } | null {
  if (btcOk == null) return null;
  const ext = btcExt != null && Number.isFinite(btcExt) ? `${btcExt >= 0 ? '+' : ''}${btcExt.toFixed(1)} ATR` : null;
  if (!btcOk) return { tone: 'bad', text: `BTC 在日線 EMA50 之下${ext ? `（${ext}）` : ''}。S3 只做多，空頭期不開新倉——這是設計，不是故障。` };
  if (breadth != null && !(breadth < BREADTH_MAX)) return { tone: 'bad', text: `市場過熱（廣度 ${(breadth * 100).toFixed(0)}% ≥ 93%），今天不開新倉。` };
  if (btcExt != null && Number.isFinite(btcExt) && btcExt < S3_TH.btc) {
    return { tone: 'warn', text: `BTC 站上 EMA50 但還不夠強（${ext}，要 ≥ +${S3_TH.btc.toFixed(1)} ATR 才給分）。有突破也多半拿不到 2 分，進場機會少。` };
  }
  return { tone: 'ok', text: `BTC 趨勢強${ext ? `（${ext}）` : ''}。出現突破且止損距離 ≤ ${(S3_TH.risk * 100).toFixed(0)}%、7 日漲幅 < ${(S3_TH.ret7 * 100).toFixed(0)}% 就會進場。` };
}
