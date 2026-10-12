// `npm run status` 的 S3 真倉判語（純函數，測試 tests/s3StatusCheck.test.ts）。
//
// 2026-10-12：status 原本只看舊策略（Supabase trades），S3 上線後它印的「回撤停機中」
// 「7 天沒有新訊號」都跟 S3 無關，而 S3 該看的（今天有沒有決策、持倉的止損單在不在、
// 對帳結果）一個都沒有。判斷集中在這裡，status.ts 只負責抓資料和印。

import { S3A } from '../../engine/s3aLive';
import { XCHECK_STALE_MS } from './xcheckAlert';

const DAY = 86_400_000;
const H = 3_600_000;

export interface S3StatusInput {
  now: number;
  /** s3a-live:meta.lastDay：最後一次跑完每日決策的決策日 */
  lastDay: number;
  mode: string | null;
  walletAt: number | null;
  legs: { name: string; halted: string | null }[];
  positions: { symbol: string; stopAlgoId: number | null; tpAlgoId: number | null; partial: boolean }[];
  /** 交易所上的部位（symbol → 數量）；null = 沒查交易所 */
  exchangeQty: Record<string, number> | null;
  algos: { symbol: string; algoId: number }[] | null;
  xcheck: { lastAt: number | null; badDays: string[] };
}

export interface Finding { level: 'ok' | 'warn' | 'bad'; msg: string }

export function s3Findings(i: S3StatusInput): Finding[] {
  const out: Finding[] = [];
  const X = Math.floor(i.now / DAY) * DAY;

  if (i.lastDay >= X) out.push({ level: 'ok', msg: '今天的進場決策已跑完' });
  else if (i.now - X > S3A.ENTRY_WINDOW_MS) {
    out.push({ level: 'bad', msg: `今天（UTC ${new Date(X).toISOString().slice(0, 10)}）沒有跑進場決策，進場窗口已過——live-runner 在 UTC 00:00～02:00 之間可能沒在跑` });
  } else out.push({ level: 'ok', msg: '今天的進場決策還沒跑（仍在 UTC 00:00～02:00 窗口內）' });

  if (i.mode === 'dry') out.push({ level: 'warn', msg: 'live-runner 是 S3A_DRY_RUN 模式：只印不下單' });
  if (i.walletAt == null || i.now - i.walletAt > 2 * H) {
    out.push({ level: 'warn', msg: `testnet 權益超過 2 小時沒更新（live-runner 每小時寫一次）——runner 可能沒在跑或不是最新版` });
  }
  for (const l of i.legs) if (l.halted) out.push({ level: 'warn', msg: `${l.name} 已停用開新倉：${l.halted}` });

  if (i.exchangeQty && i.algos) {
    const ids = new Set(i.algos.map(a => a.algoId));
    for (const p of i.positions) {
      const coin = p.symbol.replace('USDT', '');
      if (!(i.exchangeQty[p.symbol] > 0)) {
        out.push({ level: 'bad', msg: `${coin}：Redis 記著持倉，但交易所沒有部位——可能已出場但還沒結算，或被手動平倉` });
        continue;
      }
      if (p.stopAlgoId == null || !ids.has(p.stopAlgoId)) {
        out.push({ level: 'bad', msg: `${coin}：交易所上找不到止損單（algoId ${p.stopAlgoId ?? '無'}），下檔沒有保護` });
      }
      if (!p.partial && (p.tpAlgoId == null || !ids.has(p.tpAlgoId))) {
        out.push({ level: 'warn', msg: `${coin}：止盈還沒成交，但交易所上找不到止盈單（algoId ${p.tpAlgoId ?? '無'}）` });
      }
    }
  }

  if (i.xcheck.badDays.length) out.push({ level: 'bad', msg: `每日對帳不一致：${i.xcheck.badDays.join('、')}（研究端重算 ≠ 線上）` });
  if (i.xcheck.lastAt == null) out.push({ level: 'warn', msg: '每日對帳從沒跑過（工作排程器「S3 每日對帳」）' });
  else if (i.now - i.xcheck.lastAt > XCHECK_STALE_MS) out.push({ level: 'warn', msg: '每日對帳超過 3 天沒跑' });

  return out;
}
