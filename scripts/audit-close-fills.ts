#!/usr/bin/env npx tsx
/**
 * 「止損／止盈觸發了，但真的把部位平乾淨了嗎？」——唯讀對帳。
 *
 *   ENV_FILE=env.txt npm run audit-close-fills
 *   npm run audit-close-fills -- --days 14 --symbol UNIUSDT
 *
 * 為什麼有這支：2026-09-06 UNIUSDT 的移動止損連續四次平錯數量都沒人發現
 * （82→平41、31→平10、21→平20，最後部位剩 1 張卻平了 40 張，把多單翻成
 * -39 的空單裸奔十小時）。既有工具看不到這件事——`npm run status` 只看
 * 當下有沒有保護單，`npm run audit-exits` 對的是損益不是數量。
 *
 * 判讀方式（實際的分類邏輯與「為什麼從現在往回推」見 src/lib/closeFillAudit.ts）：
 *   clean    平乾淨，部位歸零
 *   partial  沒平乾淨，還有剩。TP1 只平一半是正常的，止損出現這個就不正常
 *   flipped  平過頭，方向反了——最嚴重，新開的反向部位沒有任何保護單
 *
 * 需要 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADING_USER_ID
 * 與幣安 testnet 金鑰。
 */

import { createClient } from '@supabase/supabase-js';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { BinanceFuturesClient, loadBinanceConfigFromEnv, UserTrade } from '../src/engine/binanceClient';
import { auditCloseFills, AuditRow, AuditTriggeredAlgo } from '../src/lib/closeFillAudit';

const DAY = 86400_000;
const PAGE = 1000; // 幣安 userTrades 單次上限

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// 分頁抓完整成交紀錄。**不能只抓一頁**：closeFillAudit 是「從現在的部位往回
// 減」，缺任何一筆觸發之後的成交，算出來的觸發前部位就是錯的——而且是靜悄悄
// 地錯。幣安不接受 fromId 與 startTime 併用，所以第一頁用時間窗、之後用 id 遊標。
//
// 2026-09-06 第一版實測踩到：續抓條件寫成「回滿 1000 筆才續抓」，漏掉了另一種
// 截斷——**userTrades 的時間窗上限是 7 天**，startTime 帶 8 天前，幣安只回
// startTime 之後 7 天內的成交就結束，筆數遠少於 1000，迴圈直接不跑。結果最新
// 的成交全部缺席，而 auditCloseFills 是「從現在往回減」，缺最新的等於整串
// 觸發前部位全錯（UNI 那串每一列都少 1，看起來還很合理，這才是危險的地方）。
//
// 改成「一直用 id 遊標往後抓，直到回空為止」——fromId 沒有時間窗限制，兩種
// 截斷都接得住。多打幾次 API 換一個不會靜悄悄出錯的結果，值得。
async function fetchAllFills(bn: BinanceFuturesClient, symbol: string, startTime: number): Promise<UserTrade[]> {
  const out: UserTrade[] = [];
  let page = await bn.getUserTrades(symbol, { startTime, limit: PAGE });
  while (page.length > 0) {
    out.push(...page);
    const fromId = Math.max(...page.map(t => t.id)) + 1;
    page = await bn.getUserTrades(symbol, { fromId, limit: PAGE });
  }
  return out;
}

const VERDICT_LABEL: Record<AuditRow['verdict'], string> = {
  clean: '✅ 平乾淨',
  partial: '⚠ 沒平乾淨',
  flipped: '🔴 平過頭翻倉',
};

function fmtQty(n: number): string {
  // 浮點殘渣（4.4e-16 那種）印成 "-0" 會讓人以為真的有殘留部位。
  if (Math.abs(n) < 1e-9) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

async function main() {
  reportEnvLoad(loadEnvFile());
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const uid = process.env.TRADING_USER_ID;
  if (!url || !key || !uid) throw new Error('缺 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TRADING_USER_ID');

  const days = parseInt(arg('days') ?? '7', 10);
  const only = arg('symbol');
  const since = Date.now() - days * DAY;

  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const bn = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));

  const { data: trades } = await db.from('trades').select('symbol')
    .eq('user_id', uid).gte('opened_at', since).not('exchange_entry_order_id', 'is', null);
  const symbols = only
    ? [only]
    : Array.from(new Set((trades ?? []).map(t => t.symbol as string))).sort();

  if (symbols.length === 0) {
    console.log(`近 ${days} 天沒有任何真倉，沒東西可對帳。`);
    return;
  }
  console.log(`\n對帳範圍：近 ${days} 天，${symbols.length} 個 symbol\n`);

  const all: Array<{ symbol: string; row: AuditRow }> = [];

  for (const symbol of symbols) {
    let rows: AuditRow[];
    try {
      const [positions, history] = await Promise.all([
        bn.getPositionRisk(symbol),
        bn.getAlgoOrderHistory(symbol, { startTime: since, limit: 500 }),
      ]);

      const triggered: AuditTriggeredAlgo[] = history
        .filter(a => a.actualOrderId != null && a.triggerTime != null && a.actualQty != null)
        .map(a => ({
          clientAlgoId: a.clientAlgoId,
          orderType: a.orderType,
          side: a.side,
          triggerTime: a.triggerTime as number,
          actualQty: parseFloat(a.actualQty as string),
          closePosition: a.closePosition,
        }));

      if (triggered.length === 0) {
        console.log(`${symbol.padEnd(12)} 期間沒有任何條件單被觸發`);
        continue;
      }

      // 成交要從「最早那筆觸發」之前開始抓才夠——只抓 since 之後不一定涵蓋
      // 得到（條件單可能在視窗開頭就觸發）。多抓一天當緩衝。
      const earliest = Math.min(...triggered.map(t => t.triggerTime));
      const fills = await fetchAllFills(bn, symbol, Math.min(since, earliest - DAY));

      // 截斷偵測。每一張觸發過的條件單都一定有對應的成交，所以「最新的觸發
      // 時間」不可能晚於「最新的成交時間」——會的話就是成交沒抓完整，這時候
      // 算出來的每一列都是錯的（2026-09-06 第一版就是這樣，每列少一筆，數字
      // 看起來還很合理）。寧可整個 symbol 不報，也不要報錯的。
      const latestFill = fills.length > 0 ? Math.max(...fills.map(f => f.time)) : 0;
      const latestTrigger = Math.max(...triggered.map(t => t.triggerTime));
      if (latestTrigger > latestFill) {
        console.error(`${symbol.padEnd(12)} ⚠ 成交紀錄不完整（最新成交 ${new Date(latestFill).toISOString()}`
          + ` 早於最新觸發 ${new Date(latestTrigger).toISOString()}），跳過——重建出來的部位會是錯的`);
        continue;
      }

      // 部位一定要用這個 symbol 自己的那一筆。positionRisk 帶 symbol 查理論上
      // 只會回一筆，但這個專案已經有兩個「幣安端點的 symbol 篩選不可信」的
      // 前例（getOpenAlgoOrders、getUserTrades），這裡明確 filter 不靠順序。
      const pos = positions.find(p => p.symbol === symbol);

      rows = auditCloseFills({
        currentPosition: pos ? parseFloat(pos.positionAmt) : 0,
        fills: fills.map(f => ({ time: f.time, side: f.side, qty: parseFloat(f.qty) })),
        triggered,
      });
    } catch (e) {
      const detail = (e as { response?: { data?: unknown } })?.response?.data ?? String(e);
      console.error(`${symbol.padEnd(12)} 查詢失敗，跳過：${JSON.stringify(detail).slice(0, 200)}`);
      continue;
    }

    for (const row of rows) {
      all.push({ symbol, row });
      console.log([
        symbol.padEnd(12),
        new Date(row.triggerTime).toISOString(),
        row.orderType.padEnd(19),
        `CP=${String(row.closePosition).padEnd(5)}`,
        `觸發前 ${fmtQty(row.positionBefore).padStart(10)}`,
        `平掉 ${fmtQty(row.closedQty).padStart(10)}`,
        `之後 ${fmtQty(row.positionAfter).padStart(10)}`,
        VERDICT_LABEL[row.verdict],
        row.clientAlgoId,
      ].join(' '));
    }
  }

  const flipped = all.filter(a => a.row.verdict === 'flipped');
  const partial = all.filter(a => a.row.verdict === 'partial' && a.row.orderType.startsWith('STOP'));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`觸發過的條件單共 ${all.length} 張：`
    + ` 平乾淨 ${all.filter(a => a.row.verdict === 'clean').length}`
    + ` / 沒平乾淨 ${all.filter(a => a.row.verdict === 'partial').length}`
    + ` / 翻倉 ${flipped.length}`);

  if (flipped.length > 0) {
    console.log(`\n🔴 有 ${flipped.length} 張條件單平過頭把部位翻向了。翻出來的反向部位沒有任何保護單，`);
    console.log(`   而且 DB 那筆 trade 的方向從此是錯的。先跑 npm run status 看現在還有沒有這種部位。`);
  }
  if (partial.length > 0) {
    console.log(`\n⚠ 有 ${partial.length} 張**止損單**沒把部位平乾淨（TP1 只平一半是正常的，止損不是）。`);
    console.log(`   這代表那筆 trade 在 DB 看起來已經出場、實際上還有部位掛在交易所。`);
  }
}

main().catch(e => {
  console.error('對帳失敗：', (e as { response?: { data?: unknown } })?.response?.data ?? (e as Error).message ?? e);
  process.exit(1);
});
