// /api/s3/* 的回應格式（前端頁面與 API route 共用的型別）。
import type { LivePos, LiveSignal } from '@/engine/s3aLive';
import type { Position, SignalLog } from './engine';
import type { AcctSummary, LiveDone, LiveSummary } from './stats';
import type { CtrendSummary } from '@/lib/ctrend/view';

export interface OverviewResp {
  ok: boolean; reason?: string; now: number;
  meta: Record<string, unknown>;
  positions: LivePos[];
  snapshot: { X: number; breadth: number; btcOk: Record<string, boolean>; btcExt?: Record<string, number>; s3: { symbol: string }[] } | null;
  heartbeatAt: number | null;
  signals: LiveSignal[];
}

export interface SignalsResp { ok: boolean; reason?: string; live: LiveSignal[]; ledger: SignalLog[] }

export interface LedgerAcct { summary: AcctSummary; open: Position[]; recent: Position[]; blocked: Record<string, number> }
export interface LedgersResp {
  ok: boolean; reason?: string;
  trackStart: { s3: number | null; s1: number | null };
  lastRun: { s3: number | null; s1: number | null };
  accounts: LedgerAcct[];
  ctrend: CtrendSummary | null;   // CTREND 前向週帳本（EC2 每週一寫 ctrend:*），還沒跑過 = null
}

export type LiveClosed = LivePos & LiveDone;
export interface TradesResp { ok: boolean; reason?: string; summaries: LiveSummary[]; open: LivePos[]; done: LiveClosed[] }
