#!/usr/bin/env npx tsx
/**
 * S3-A testnet 執行模組的唯讀試跑：讀真的 testnet 帳戶與線上 Redis，但**不下任何單、不寫線上 Redis**
 * （寫入都留在記憶體），印出它「會」做什麼。
 *
 *   ENV_FILE=env.txt npm run s3a-dryrun              # 用現在的時間
 *   ENV_FILE=env.txt npm run s3a-dryrun -- --at-open  # 假裝現在是今天 UTC 00:01（看今天開盤會怎麼進場；價格仍是現價）
 */
import { Redis } from '@upstash/redis';
import { loadEnvFile, reportEnvLoad } from './loadEnvFile';
import { BinanceFuturesClient, loadBinanceConfigFromEnv } from '../src/engine/binanceClient';
import { parseSymbolFilters } from '../src/engine/precision';
import { runS3aLive, type S3aStore } from '../src/engine/s3aLive';
import { runPrep, type Store } from '../src/lib/s3s1/engine';
import { binanceS3S1Deps } from '../src/lib/s3s1/deps';
import { fetchClosedBars, fetchFundingHistory } from '../src/api/binance';

/** 讀穿到 Redis、寫只進記憶體 */
class Overlay implements Store, S3aStore {
  kv = new Map<string, string>(); h = new Map<string, Map<string, string>>();
  constructor(private r: Redis) {}
  async get(k: string) { return this.kv.has(k) ? this.kv.get(k) : this.r.get(k); }
  async set(k: string, v: string) { this.kv.set(k, v); return 'OK'; }
  async hgetall(k: string) {
    const base = ((await this.r.hgetall<Record<string, unknown>>(k)) ?? {}) as Record<string, unknown>;
    const o = this.h.get(k);
    const m = { ...base, ...(o ? Object.fromEntries(o) : {}) };
    return Object.keys(m).length ? m : null;
  }
  async hset(k: string, kv: Record<string, string>) { if (!this.h.has(k)) this.h.set(k, new Map()); for (const [a, b] of Object.entries(kv)) this.h.get(k)!.set(a, b); return 1; }
  async hdel() { return 1; }
  async lpush() { return 1; }
  async ltrim() { return 'OK'; }
}

async function main(): Promise<void> {
  reportEnvLoad(loadEnvFile());
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const binance = new BinanceFuturesClient(loadBinanceConfigFromEnv(true));
  const store = new Overlay(redis);
  const filters = parseSymbolFilters(await binance.getExchangeInfo() as Parameters<typeof parseSymbolFilters>[0]);
  const bal = (await binance.getBalance()).find(b => b.asset === 'USDT');
  console.log(`testnet 錢包餘額 ${bal?.balance} USDT（可用 ${bal?.availableBalance}）；testnet 合約 ${filters.size} 檔`);
  const t0 = Date.now();
  const atOpen = process.argv.includes('--at-open');
  const now = atOpen ? Math.floor(t0 / 86_400_000) * 86_400_000 + 60_000 : t0;
  if (atOpen) console.log('（--at-open：假裝現在是 UTC 00:01）');
  await runS3aLive({
    client: binance, store, filters,
    mainnetDaily: s => fetchClosedBars(s, '1d', 499),
    mainnetFunding: (s, t) => fetchFundingHistory(s, 100, t),
    ensurePrep: async now => { if (!(await store.get(`s3s1:prep:${Math.floor(now / 86_400_000) * 86_400_000}`))) await runPrep(store, binanceS3S1Deps, now); },
    notify: async (title, body) => console.log(`   [推播] ${title}｜${body}`),
    log: m => console.log(m),
    dryRun: true, killSwitch: false, now,
  });
  console.log(`\n完成（${((Date.now() - t0) / 1000).toFixed(1)} 秒）。以上只是「會做的事」，沒有下任何單。`);
}

main().catch(e => { console.error(e); process.exit(1); });
