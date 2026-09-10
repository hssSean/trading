// 量「掃描的 CPU 被哪個時框吃掉」——決定要不要把 5m/15m 移出主掃描迴圈。
//
// 為什麼不直接看線上 log：策略 A 的多時框迴圈只在 regime='trending' 時執行，
// 而 2026-09-10 當下 BTC 是 chaotic、主流幣全部 ranging，跑一次真掃描三檔幣
// 全走策略 B（只算 1h），量不到要量的東西。這支不依賴市況。
//
// 量兩件事，因為它們的付費頻率不同：
//   1. fetch + JSON 解析：**每一輪掃描、每個時框都要付**，signalCache 擋不住
//   2. generateSignals：只在該時框收出新 K 線時付（signalCache 命中就跳過）
//
// 每小時的重算次數比例是 5m : 15m : 1h = 12 : 4 : 1，所以 (2) 的加權跟 (1)
// 完全不同，不能只比單次耗時。
//
// 用法：npx tsx scripts/scan-cpu-profile.ts [幣數=5] [每項重複次數=3]

import { fetchCandles } from '../src/api/binance';
import { generateSignals } from '../src/analysis/signals';
import type { Candle, Timeframe } from '../src/types';

const TFS: Timeframe[] = ['5m', '15m', '1h'];

// 一小時內各時框會收出幾根新 K 線 ＝ generateSignals 被真正呼叫幾次。
const RECOMPUTES_PER_HOUR: Record<string, number> = { '5m': 12, '15m': 4, '1h': 1 };

// 掃描節奏（秒）。scan-run-lock 的 TTL 決定，見 route.ts。
const SCAN_INTERVAL_SEC = 240;

const COINS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
               'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'SUIUSDT'];

function hrms(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

async function main() {
  const nCoins = parseInt(process.argv[2] ?? '5', 10);
  const reps   = parseInt(process.argv[3] ?? '3', 10);
  const coins  = COINS.slice(0, nCoins);

  console.log(`量測 ${coins.length} 檔 × ${TFS.length} 時框 × ${reps} 次\n`);

  // ── 先把 K 線全抓下來（順便量 fetch+parse），之後純算不再碰網路 ──
  const candles = new Map<string, Candle[]>();
  const fetchMs: Record<string, number> = {};

  for (const tf of TFS) {
    let total = 0;
    for (const symbol of coins) {
      const t0 = hrms();
      const c  = await fetchCandles(symbol, tf, 200);
      total += hrms() - t0;
      candles.set(`${symbol}:${tf}`, c);
    }
    fetchMs[tf] = total / coins.length;
  }

  // ⚠ fetch 含網路往返，那不是 CPU。要的是「拿到 body 之後解析成物件」的成本，
  // 所以另外量一次純解析：把已抓到的資料序列化再解析回來，這是 fetchCandles
  // 內部真正燒 CPU 的那一段的下界。
  const parseMs: Record<string, number> = {};
  for (const tf of TFS) {
    let total = 0;
    for (const symbol of coins) {
      const raw = JSON.stringify(candles.get(`${symbol}:${tf}`)!);
      const t0  = hrms();
      for (let i = 0; i < reps; i++) JSON.parse(raw);
      total += (hrms() - t0) / reps;
    }
    parseMs[tf] = total / coins.length;
  }

  // ── generateSignals 單次成本 ──
  const genMs: Record<string, number> = {};
  for (const tf of TFS) {
    let total = 0;
    for (const symbol of coins) {
      const c = candles.get(`${symbol}:${tf}`)!;
      // 丟掉第一次（JIT 暖機），之後取平均
      generateSignals(symbol, tf, c, null, 'trending');
      const t0 = hrms();
      for (let i = 0; i < reps; i++) generateSignals(symbol, tf, c, null, 'trending');
      total += (hrms() - t0) / reps;
    }
    genMs[tf] = total / coins.length;
  }

  // ── 換算成每小時每檔幣的 CPU ──
  const scansPerHour = 3600 / SCAN_INTERVAL_SEC;
  console.log(`每小時掃描 ${scansPerHour} 輪（scan-run-lock TTL ${SCAN_INTERVAL_SEC}s）\n`);
  console.log('時框    解析/次   產訊號/次   解析×輪數   產訊號×重算   每小時合計   佔比');

  const perHour: Record<string, number> = {};
  for (const tf of TFS) {
    const parseTotal = parseMs[tf] * scansPerHour;
    const genTotal   = genMs[tf] * RECOMPUTES_PER_HOUR[tf];
    perHour[tf] = parseTotal + genTotal;
  }
  const grand = TFS.reduce((s, tf) => s + perHour[tf], 0);

  for (const tf of TFS) {
    const parseTotal = parseMs[tf] * scansPerHour;
    const genTotal   = genMs[tf] * RECOMPUTES_PER_HOUR[tf];
    console.log(
      `${tf.padEnd(6)} ${parseMs[tf].toFixed(2).padStart(7)}ms ${genMs[tf].toFixed(2).padStart(9)}ms` +
      ` ${parseTotal.toFixed(0).padStart(9)}ms ${genTotal.toFixed(0).padStart(12)}ms` +
      ` ${perHour[tf].toFixed(0).padStart(11)}ms ${(perHour[tf] / grand * 100).toFixed(1).padStart(6)}%`,
    );
  }

  const cut = perHour['5m'] + perHour['15m'];
  console.log(`\n每檔幣每小時合計 ${grand.toFixed(0)}ms`);
  console.log(`砍掉 5m+15m 可省 ${cut.toFixed(0)}ms = ${(cut / grand * 100).toFixed(1)}%`);
  console.log(`\n（參考）fetch 含網路往返：${TFS.map(tf => `${tf} ${fetchMs[tf].toFixed(0)}ms`).join(' / ')}`);
  console.log('fetch 的網路等待在 Vercel Fluid 上不算 active CPU，所以上表用解析成本而非 fetch 成本。');
}

main().catch(e => { console.error(e); process.exit(1); });
