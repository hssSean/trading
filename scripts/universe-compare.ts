#!/usr/bin/env npx tsx
/**
 * 選幣圈比較 — 「成交量名次 1-15」對上「名次 16-30」，同一套策略同一段期間。
 *
 *   npx tsx scripts/universe-compare.ts [MONTHS] [GROUP_SIZE]
 *   npx tsx scripts/universe-compare.ts 3 10
 *
 * 為什麼是這支而不是在 route.ts 加影子掃描：
 *   route.ts 的每檔幣訊號產生跟 regime 判定、ATR 百分位、策略B暫停、
 *   signalCache、HTF bias、多時框迴圈全部糾纏在一起。要嘛重構那條即時
 *   訊號路徑（為了量測去冒斷掉正式訊號的風險），要嘛另寫簡化版（管線
 *   不同，比較結果會被管線差異污染，等於白做）。這支直接 import
 *   backtest.ts 的 runBacktest，兩組跑在**完全同一套模擬**上。
 *
 * 已知偏誤（看數字前一定要先讀）：
 *   1. 生存者偏誤。名次是「今天」的排名，拿去回測過去三個月，等於用
 *      未來資訊選幣——今天排 16-30 的幣，有些是最近才漲上來的。這會
 *      系統性高估兩組的表現，而且不保證對兩組一樣。
 *   2. backtest.ts 只用 1H（4H 由 1H 合成），正式站是多時框。絕對數字
 *      不等於正式站表現。
 *   3. MIN_SCORE_A=70 比正式站現在的 65 嚴格。
 *   因為 1、2、3 對兩組**完全一致**，所以「哪一組比較好」這個相對比較
 *   仍然有參考價值；但任何一組的絕對數字都不可以拿去當預期報酬。
 *
 * 損益一律換算成 R 倍數（CLAUDE.md：ATR 止損的原始 % 會嚴重誤導）。
 */

import axios from 'axios';
import { fetchHistorical, runBacktest, type SimTrade } from './backtest';

const MONTHS = Math.max(1, parseInt(process.argv[2] ?? '3', 10));
const GROUP  = Math.max(1, parseInt(process.argv[3] ?? '10', 10));

const EXCLUDE = /^(USDC|BUSD|TUSD|USDP|FDUSD|DAI|EUR|GBP|AUD|BVOL|IBVOL|BEAR|BULL|UP|DOWN|3L|3S)/;

async function rankedSymbols(): Promise<{ symbol: string; volM: number }[]> {
  const base = 'https://fapi.binance.com/fapi/v1';
  const [info, tick] = await Promise.all([
    axios.get(`${base}/exchangeInfo`).then(r => r.data),
    axios.get(`${base}/ticker/24hr`).then(r => r.data),
  ]);
  const perp = new Set<string>(
    (info.symbols as { symbol: string; status: string; contractType: string }[])
      .filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.symbol.endsWith('USDT'))
      .map(s => s.symbol),
  );
  return (tick as { symbol: string; quoteVolume: string }[])
    .filter(t => perp.has(t.symbol) && !EXCLUDE.test(t.symbol.replace('USDT', '')))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => ({ symbol: t.symbol, volM: Math.round(parseFloat(t.quoteVolume) / 1e6) }));
}

// R = 損益% ÷ 止損距離%。止損距離用進場價與 SL 的距離，跟正式站同一套口徑。
function toR(t: SimTrade): number {
  const stopDistPct = Math.abs(t.entry - t.sl) / t.entry * 100;
  return stopDistPct > 0 ? t.pnlPct / stopDistPct : 0;
}

interface GroupStat {
  label: string;
  symbols: number;
  trades: number;
  wins: number;
  netR: number;
  avgR: number;
  sdR: number;
  winRate: number;
  perSymbol: { symbol: string; n: number; netR: number }[];
}

function summarise(label: string, rows: { symbol: string; trades: SimTrade[] }[]): GroupStat {
  const all = rows.flatMap(r => r.trades);
  const rs = all.map(toR);
  const netR = rs.reduce((s, v) => s + v, 0);
  const wins = all.filter(t => t.result !== 'LOSS').length;
  const avgR = all.length ? netR / all.length : 0;
  const sdR = all.length > 1
    ? Math.sqrt(rs.reduce((s, v) => s + (v - avgR) ** 2, 0) / (rs.length - 1))
    : 0;
  return {
    label,
    symbols: rows.length,
    trades: all.length,
    wins,
    netR,
    avgR,
    sdR,
    winRate: all.length ? wins / all.length : 0,
    perSymbol: rows
      .map(r => ({ symbol: r.symbol, n: r.trades.length, netR: r.trades.reduce((s, t) => s + toR(t), 0) }))
      .sort((a, b) => b.netR - a.netR),
  };
}

function print(g: GroupStat): void {
  console.log(`\n── ${g.label} ──`);
  console.log(`  幣種數    : ${g.symbols}`);
  console.log(`  交易筆數  : ${g.trades}  (勝 ${g.wins})`);
  console.log(`  勝率      : ${(g.winRate * 100).toFixed(1)}%`);
  console.log(`  淨 R      : ${g.netR >= 0 ? '+' : ''}${g.netR.toFixed(2)}R`);
  console.log(`  每筆平均  : ${g.avgR >= 0 ? '+' : ''}${g.avgR.toFixed(3)}R  (標準差 ${g.sdR.toFixed(2)}R)`);
  console.log('  各幣淨R   :');
  for (const s of g.perSymbol) {
    console.log(`    ${s.symbol.replace('USDT', '').padEnd(10)} n=${String(s.n).padStart(3)}  ${s.netR >= 0 ? '+' : ''}${s.netR.toFixed(2)}R`);
  }
}

async function main(): Promise<void> {
  const ranked = await rankedSymbols();
  const groupA = ranked.slice(0, GROUP);
  const groupB = ranked.slice(15, 15 + GROUP);

  console.log('='.repeat(64));
  console.log(`  選幣圈比較  |  ${MONTHS} 個月  |  每組 ${GROUP} 檔`);
  console.log(`  A 組（名次 1-${GROUP}）    : ${groupA.map(s => s.symbol.replace('USDT', '')).join(' ')}`);
  console.log(`  B 組（名次 16-${15 + GROUP}） : ${groupB.map(s => s.symbol.replace('USDT', '')).join(' ')}`);
  console.log('  ⚠ 生存者偏誤：名次是今天的，回測的是過去。絕對數字不可當預期報酬。');
  console.log('='.repeat(64));

  const run = async (list: { symbol: string; volM: number }[]) => {
    const out: { symbol: string; trades: SimTrade[] }[] = [];
    for (const { symbol, volM } of list) {
      process.stdout.write(`  ${symbol} (${volM}M) ... `);
      try {
        const candles = await fetchHistorical(symbol, MONTHS);
        const trades = runBacktest(symbol, candles);
        out.push({ symbol, trades });
        console.log(`${trades.length} 筆`);
      } catch (e) {
        // 上市不滿回測期間的幣會 K 線不足——照實跳過並印出來，不要靜默
        // 丟掉（靜默跳過會讓 B 組看起來樣本比較少卻不知道為什麼）。
        console.log(`跳過：${String(e).slice(0, 60)}`);
      }
    }
    return out;
  };

  console.log('\nA 組回測中...');
  const a = summarise(`A 組 — 成交量名次 1-${GROUP}`, await run(groupA));
  console.log('\nB 組回測中...');
  const b = summarise(`B 組 — 成交量名次 16-${15 + GROUP}`, await run(groupB));

  print(a);
  print(b);

  console.log('\n' + '='.repeat(64));
  console.log('  結論');
  console.log(`    A 組每筆平均 ${a.avgR >= 0 ? '+' : ''}${a.avgR.toFixed(3)}R（${a.trades} 筆）`);
  console.log(`    B 組每筆平均 ${b.avgR >= 0 ? '+' : ''}${b.avgR.toFixed(3)}R（${b.trades} 筆）`);
  const diff = b.avgR - a.avgR;
  console.log(`    差距 ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}R/筆（B 減 A）`);

  // Welch t 檢定。沒有誤差範圍的差距數字最危險——「B 組多 0.13R」看起來像
  // 結論，但每筆 R 的標準差通常在 1R 以上，兩三百筆的標準誤就有 0.07R 左右，
  // 這種差距很可能只是雜訊。這個專案的調參紀律要求先看數據，那數據就必須
  // 附帶「這個差距分不分得出來」。
  const se = Math.sqrt(a.sdR ** 2 / a.trades + b.sdR ** 2 / b.trades);
  const t  = se > 0 ? diff / se : 0;
  console.log(`    標準誤 ±${se.toFixed(3)}R   t = ${t.toFixed(2)}`);
  if (Math.abs(t) < 2) {
    console.log('    → |t| < 2：兩組分不出差別。這個差距是雜訊，不可據此擴大選幣圈。');
  } else {
    console.log('    → |t| ≥ 2：差距在統計上分得出來，但仍受下列偏誤影響，需前向驗證。');
  }
  if (a.trades < 30 || b.trades < 30) {
    console.log('    ⚠ 任一組樣本 < 30 筆，這個差距沒有統計意義，不要據此調整。');
  }
  console.log('');
  console.log('  ⚠ 這份結果有一個會偏向 B 組的系統性偏誤：');
  console.log('    backtest.ts 對「同一根K線同時觸及 TP 和 SL」一律判贏（TP 優先）。');
  console.log('    1H OHLC 看不出誰先到，判贏是最樂觀的假設。B 組是波動較大的');
  console.log('    中型幣，K線更寬、同根同時觸及的機率更高，因此從這個假設拿到');
  console.log('    的好處比 A 組多。B 組的優勢有多少是真的，這份回測答不出來。');
  console.log('='.repeat(64));
}

main().catch(err => {
  console.error('universe-compare error:', err);
  process.exit(1);
});
