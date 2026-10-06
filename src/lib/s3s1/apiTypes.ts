// /api/s3/* 的回應格式（前端頁面與 API route 共用的型別）。
import type { LivePos, LiveSignal } from '@/engine/s3aLive';
import type { Position, SignalLog } from './engine';
import type { AcctSummary, LiveDone, LiveSummary } from './stats';

export interface OverviewResp {
  ok: boolean; reason?: string; now: number;
  meta: Record<string, unknown>;
  positions: LivePos[];
  snapshot: { X: number; breadth: number; btcOk: Record<string, boolean>; s3: { symbol: string }[] } | null;
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
}

export type LiveClosed = LivePos & LiveDone;
export interface TradesResp { ok: boolean; reason?: string; summary: LiveSummary; open: LivePos[]; done: LiveClosed[] }
