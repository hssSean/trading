'use client';
// 績效體檢：把交易紀錄丟進統計裁決引擎，判斷獲利是「可重複的優勢」還是「運氣/賭博」。
// 隱私（硬性）：所有計算在瀏覽器本地執行；本頁不發出任何含交易資料的網路請求，
// 也不把交易資料寫入 localStorage。

import { useCallback, useMemo, useRef, useState } from 'react';
import { AnalysisResult, analyzeLog } from '@/lib/antigambling/analyzer';
import { EXAMPLE_FILES } from '@/lib/antigambling/examples';
import {
  blankTemplateCsv,
  decodeFileBytes,
  FieldMappingError,
  IngestResult,
  parseTradeLog,
  STANDARD_FIELDS,
} from '@/lib/antigambling/ingest';
import { Market, uncoveredCostWarnings } from '@/lib/antigambling/markets';
import { fmtRatio } from '@/lib/antigambling/metrics';
import { sortedByTime } from '@/lib/antigambling/models';
import { tagDescriptor } from '@/lib/antigambling/pertag';
import { LEVEL_BADGE, LEVEL_DISPLAY, VerdictLevel } from '@/lib/antigambling/verdict';
import { EquityCurveChart, PnlHistogram } from '@/features/health-check/charts';

type Step = 'upload' | 'mapping' | 'preview' | 'result';
type FileFormat = 'csv' | 'json' | 'tsv';

const FIELD_LABELS: Record<string, string> = {
  symbol: '標的代號 *',
  side: '方向（多/空）',
  entry_time: '進場時間',
  exit_time: '出場時間',
  entry_price: '進場價',
  exit_price: '出場價',
  quantity: '數量',
  fees: '費用',
  pnl: '損益（與價格欄二擇一）',
  tag: '策略標籤',
};

const LEVEL_STYLE: Record<VerdictLevel, { bg: string; border: string; text: string }> = {
  gambling:         { bg: 'bg-red-500/10',    border: 'border-red-500/50',    text: 'text-red-400' },
  insufficient:     { bg: 'bg-orange-500/10', border: 'border-orange-500/50', text: 'text-orange-400' },
  luck_suspected:   { bg: 'bg-yellow-500/10', border: 'border-yellow-500/40', text: 'text-yellow-400' },
  fragile_edge:     { bg: 'bg-yellow-500/10', border: 'border-yellow-500/40', text: 'text-yellow-400' },
  statistical_edge: { bg: 'bg-green-500/10',  border: 'border-green-500/50',  text: 'text-green-400' },
};

const MARKET_LABEL: Record<Market, string> = {
  tw_stock: '台股', tw_etf: '台股ETF', us_stock: '美股', crypto: '加密貨幣',
  tw_futures: '台指期', tw_options: '台指選擇權', forex: '外匯', unknown: '未知',
};

const signed = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function HealthCheckPage() {
  const [step, setStep] = useState<Step>('upload');
  const [fileText, setFileText] = useState('');
  const [fileName, setFileName] = useState('');
  const [format, setFormat] = useState<FileFormat>('csv');
  const [usedEncoding, setUsedEncoding] = useState<'utf-8' | 'big5'>('utf-8');
  const [errorMsg, setErrorMsg] = useState('');
  const [mappingColumns, setMappingColumns] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 解析（共用：上傳 / 範例 / 手動對應後重試）─────────────
  const tryParse = useCallback((
    text: string, fmt: FileFormat, name: string,
    enc: 'utf-8' | 'big5', ov: Record<string, string>,
  ) => {
    setErrorMsg('');
    try {
      const r = parseTradeLog({
        text, format: fmt, fileName: name, usedEncoding: enc,
        fieldOverrides: Object.keys(ov).length ? ov : undefined,
      });
      setIngest(r);
      setStep('preview');
    } catch (e) {
      if (e instanceof FieldMappingError) {
        setMappingColumns(e.columns);
        setStep('mapping');
        setErrorMsg(e.message);
      } else {
        setErrorMsg((e as Error).message);
        setStep('upload');
      }
    }
  }, []);

  const handleFile = useCallback(async (file: File) => {
    const buf = await file.arrayBuffer();
    let decoded: { text: string; encoding: 'utf-8' | 'big5' };
    try {
      decoded = decodeFileBytes(buf);
    } catch (e) {
      setErrorMsg((e as Error).message);
      return;
    }
    const lower = file.name.toLowerCase();
    const fmt: FileFormat = lower.endsWith('.json') ? 'json' : lower.endsWith('.tsv') ? 'tsv' : 'csv';
    setFileText(decoded.text);
    setFileName(file.name);
    setFormat(fmt);
    setUsedEncoding(decoded.encoding);
    setOverrides({});
    tryParse(decoded.text, fmt, file.name, decoded.encoding, {});
  }, [tryParse]);

  const loadExample = useCallback((key: string) => {
    const ex = EXAMPLE_FILES.find(e => e.key === key)!;
    setFileText(ex.content);
    setFileName(ex.fileName);
    setFormat(ex.format);
    setUsedEncoding('utf-8');
    setOverrides({});
    tryParse(ex.content, ex.format, ex.fileName, 'utf-8', {});
  }, [tryParse]);

  const downloadTemplate = useCallback(() => {
    const blob = new Blob(['﻿' + blankTemplateCsv()], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'trade-log-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const runAnalysis = useCallback(() => {
    if (!ingest) return;
    setAnalyzing(true);
    setStep('result');
    // 讓 spinner 先畫出來再跑計算（bootstrap 幾十萬次抽樣）
    setTimeout(() => {
      const r = analyzeLog(ingest.log, { nBootstrap: 5000 });
      setResult(r);
      setAnalyzing(false);
    }, 50);
  }, [ingest]);

  const reset = useCallback(() => {
    setStep('upload');
    setFileText(''); setFileName(''); setErrorMsg('');
    setIngest(null); setResult(null); setOverrides({});
  }, []);

  const marketsInLog = useMemo(() => {
    if (!ingest) return [] as Market[];
    const s = new Set<Market>();
    ingest.log.trades.forEach(t => s.add(t.market));
    return Array.from(s);
  }, [ingest]);

  const costWarnings = useMemo(() => {
    const out: string[] = [];
    for (const mk of marketsInLog) out.push(...uncoveredCostWarnings(mk));
    return out;
  }, [marketsInLog]);

  const sortedPnls = useMemo(() => {
    if (!result) return [] as number[];
    return sortedByTime(result.log).trades.map(t => t.pnl);
  }, [result]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-14 pb-3 safe-top border-b border-[#1E1E2E] shrink-0">
        <h1 className="text-[#EAEAF4] text-xl font-extrabold tracking-tight">績效體檢</h1>
        <p className="text-[#606080] text-xs mt-0.5">
          用統計學檢驗你的交易紀錄 — 是可重複的優勢，還是運氣與倖存者偏差
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 scroll-container space-y-3">

        {/* ══ 上傳 ══ */}
        {step === 'upload' && (
          <>
            <div className="px-3 py-2.5 bg-blue-500/10 border border-blue-500/30 rounded-2xl">
              <p className="text-blue-400 text-xs font-semibold">🔒 檔案僅在你的裝置上分析，不會上傳</p>
              <p className="text-[#606080] text-[10px] mt-1">所有統計計算都在瀏覽器本地執行，交易紀錄不經過任何伺服器，也不會被儲存。</p>
            </div>

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault(); setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
                dragOver ? 'border-[#F0B90B] bg-[#F0B90B]/5' : 'border-[#1E1E2E] bg-[#12121A]'
              }`}
            >
              <p className="text-4xl mb-2">📂</p>
              <p className="text-[#EAEAF4] font-bold text-sm">拖放或點擊上傳交易紀錄</p>
              <p className="text-[#606080] text-xs mt-1">支援 CSV / JSON ｜ 中英欄名自動辨識（券商/交易所匯出檔可直接用）</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.txt,.json"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
              />
            </div>

            {errorMsg && (
              <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-2xl">
                <p className="text-red-400 text-xs whitespace-pre-wrap">{errorMsg}</p>
              </div>
            )}

            <div>
              <p className="text-[#404060] text-[10px] uppercase font-bold tracking-widest mb-2">或載入範例資料看效果</p>
              <div className="space-y-2">
                {EXAMPLE_FILES.map(ex => (
                  <button
                    key={ex.key}
                    onClick={() => loadExample(ex.key)}
                    className="w-full text-left bg-[#12121A] border border-[#1E1E2E] rounded-2xl px-4 py-3 active:opacity-70"
                  >
                    <p className="text-[#EAEAF4] text-sm font-bold">{ex.label}</p>
                    <p className="text-[#606080] text-xs mt-0.5">{ex.description}</p>
                  </button>
                ))}
              </div>
            </div>

            <button onClick={downloadTemplate} className="w-full text-center text-xs text-[#606080] border border-[#1E1E2E] rounded-2xl py-2.5 active:opacity-70">
              ⬇ 下載空白範本 CSV（照格式填好再上傳）
            </button>
          </>
        )}

        {/* ══ 手動欄位對應 ══ */}
        {step === 'mapping' && (
          <>
            <div className="px-3 py-2.5 bg-orange-500/10 border border-orange-500/30 rounded-2xl">
              <p className="text-orange-400 text-xs font-semibold">無法自動辨識部分欄位 — 請手動指定對應</p>
              <p className="text-[#606080] text-[10px] mt-1">損益可由「pnl」或「進場價+出場價+數量」擇一算出；至少要讓其中一組齊全。</p>
            </div>
            <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4 space-y-3">
              {STANDARD_FIELDS.map(std => (
                <div key={std} className="flex items-center gap-3">
                  <span className="text-[#A0A0C0] text-xs w-32 shrink-0">{FIELD_LABELS[std] ?? std}</span>
                  <select
                    value={overrides[std] ?? ''}
                    onChange={e => {
                      const v = e.target.value;
                      setOverrides(prev => {
                        const next = { ...prev };
                        if (v) next[std] = v; else delete next[std];
                        return next;
                      });
                    }}
                    className="flex-1 bg-[#1A1A26] border border-[#1E1E2E] rounded-xl px-2 py-1.5 text-xs text-[#EAEAF4] outline-none"
                  >
                    <option value="">（自動 / 不使用）</option>
                    {mappingColumns.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => tryParse(fileText, format, fileName, usedEncoding, overrides)}
                className="flex-1 py-2.5 rounded-2xl bg-[#F0B90B] text-[#0A0A0F] text-sm font-bold active:opacity-80"
              >
                套用並重新解析
              </button>
              <button onClick={reset} className="px-4 py-2.5 rounded-2xl bg-[#1A1A26] text-[#606080] text-sm">取消</button>
            </div>
            {errorMsg && <p className="text-red-400 text-xs whitespace-pre-wrap">{errorMsg}</p>}
          </>
        )}

        {/* ══ 預覽確認 ══ */}
        {step === 'preview' && ingest && (
          <>
            <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[#EAEAF4] text-sm font-bold truncate">{fileName}</p>
                <span className="text-[#606080] text-xs shrink-0">{marketsInLog.map(mk => MARKET_LABEL[mk]).join('、')}</span>
              </div>
              <p className="text-xs">
                <span className="text-green-400 font-bold">{ingest.validCount} 筆有效</span>
                {ingest.skipped > 0 && <span className="text-red-400 font-bold"> ・略過 {ingest.skipped} 筆</span>}
              </p>
              {ingest.warnings.map((w, i) => (
                <p key={i} className="text-orange-400/80 text-[10px] mt-1">⚠ {w}</p>
              ))}
              {ingest.skipReasons.length > 0 && (
                <div className="mt-2 bg-[#0A0A0F] rounded-xl px-3 py-2">
                  <p className="text-[#606080] text-[10px] font-semibold mb-1">略過原因：</p>
                  {ingest.skipReasons.map((r, i) => (
                    <p key={i} className="text-[#606080] text-[10px]">• {r}</p>
                  ))}
                </div>
              )}
            </div>

            {/* 預覽表格（前 8 筆） */}
            <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-3 overflow-x-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-[#404060] text-left">
                    <th className="py-1 pr-2 font-semibold">代號</th>
                    <th className="py-1 pr-2 font-semibold">方向</th>
                    <th className="py-1 pr-2 font-semibold">出場日</th>
                    <th className="py-1 pr-2 font-semibold text-right">損益</th>
                    <th className="py-1 font-semibold">策略</th>
                  </tr>
                </thead>
                <tbody>
                  {ingest.log.trades.slice(0, 8).map((t, i) => (
                    <tr key={i} className="border-t border-[#1E1E2E]/50">
                      <td className="py-1 pr-2 text-[#EAEAF4] font-semibold">{t.symbol}</td>
                      <td className={`py-1 pr-2 ${t.side === 'long' ? 'text-green-400' : 'text-red-400'}`}>{t.side === 'long' ? '多' : '空'}</td>
                      <td className="py-1 pr-2 text-[#606080]">{t.exitTime.toLocaleDateString('zh-TW')}</td>
                      <td className={`py-1 pr-2 text-right font-bold ${t.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(t.pnl, 1)}</td>
                      <td className="py-1 text-[#606080]">{t.tag ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ingest.log.trades.length > 8 && (
                <p className="text-[#404060] text-[10px] mt-1.5 text-center">…共 {ingest.log.trades.length} 筆</p>
              )}
            </div>

            {costWarnings.length > 0 && (
              <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl px-3 py-2.5">
                <p className="text-[#606080] text-[10px] font-bold mb-1">成本模型未涵蓋（誠實揭露）：</p>
                {costWarnings.map((w, i) => (
                  <p key={i} className="text-[#606080] text-[10px] leading-4 mb-1">• {w}</p>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button onClick={runAnalysis} className="flex-1 py-3 rounded-2xl bg-[#F0B90B] text-[#0A0A0F] text-sm font-extrabold active:opacity-80">
                開始統計體檢 →
              </button>
              <button
                onClick={() => { setMappingColumns(ingest.columns); setStep('mapping'); }}
                className="px-4 py-3 rounded-2xl bg-[#1A1A26] text-[#606080] text-xs"
              >
                調整欄位
              </button>
              <button onClick={reset} className="px-4 py-3 rounded-2xl bg-[#1A1A26] text-[#606080] text-xs">取消</button>
            </div>
          </>
        )}

        {/* ══ 分析結果 ══ */}
        {step === 'result' && analyzing && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-[#F0B90B] border-t-transparent rounded-full animate-spin" />
            <p className="text-[#606080] text-xs">正在跑 t 檢定與 5000 次 Bootstrap 重抽…</p>
          </div>
        )}

        {step === 'result' && !analyzing && result && (() => {
          const v = result.verdict;
          const m = result.metrics;
          const sig = v.significance;
          const oos = result.outOfSample;
          const st = LEVEL_STYLE[v.level];
          return (
            <>
              {/* 1. 裁決橫幅 */}
              <div className={`rounded-2xl border p-4 ${st.bg} ${st.border}`}>
                <p className={`text-2xl font-extrabold ${st.text}`}>{LEVEL_BADGE[v.level]}</p>
                <p className="text-[#EAEAF4] text-sm font-bold mt-2 leading-6">{v.headline}</p>
                {v.reasons.map((r, i) => (
                  <p key={i} className="text-[#A0A0C0] text-xs mt-2 leading-5">{r}</p>
                ))}
                {v.advice.length > 0 && (
                  <div className="mt-3 bg-[#0A0A0F]/60 rounded-xl px-3 py-2.5">
                    <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-1.5">給你的建議</p>
                    {v.advice.map((a, i) => (
                      <p key={i} className="text-[#A0A0C0] text-xs leading-5 mb-1">→ {a}</p>
                    ))}
                  </div>
                )}
              </div>

              {/* 2. 核心指標卡 */}
              <div className="grid grid-cols-3 gap-1.5">
                <MetricCard label="每筆期望值" value={signed(m.expectancy)} color={m.expectancy >= 0 ? '#00C851' : '#FF4444'} sub={`總損益 ${signed(m.totalPnl, 0)}`} />
                <MetricCard label="勝率" value={pct1(m.winRate)} sub={`${m.wins}勝 ${m.losses}敗`} />
                <MetricCard label="盈虧比" value={fmtRatio(m.payoffRatio)} sub={`平均賺${m.avgWin.toFixed(0)} 賠${m.avgLoss.toFixed(0)}`} />
                <MetricCard label="獲利因子" value={fmtRatio(m.profitFactor)} sub="總獲利÷總虧損" />
                <MetricCard
                  label="最大回撤"
                  value={m.drawdownPctReliable ? pct1(m.maxDrawdownPct) : '無法計算'}
                  color={m.drawdownPctReliable && m.maxDrawdownPct > 0.5 ? '#FF4444' : undefined}
                  sub={`金額 ${m.maxDrawdown.toFixed(0)}`}
                />
                <MetricCard label="夏普 / 索提諾" value={`${fmtShort(m.sharpe)} / ${fmtShort(m.sortino)}`} sub="每筆口徑，非年化" />
              </div>

              {/* 圖表 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <EquityCurveChart pnls={sortedPnls} />
                <PnlHistogram pnls={sortedPnls} />
              </div>

              {/* 3. 統計檢定區 */}
              <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
                <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">顯著性檢定 — 這是本事還是運氣？</p>
                <div className="grid grid-cols-2 gap-1.5 mb-2">
                  <div className="bg-[#0A0A0F] rounded-xl p-2.5 text-center">
                    <p className="text-[#404060] text-[9px]">t 檢定 p 值</p>
                    <p className={`text-sm font-bold ${sig.pValueT < 0.05 ? 'text-green-400' : 'text-red-400'}`}>{sig.pValueT.toFixed(4)}</p>
                  </div>
                  <div className="bg-[#0A0A0F] rounded-xl p-2.5 text-center">
                    <p className="text-[#404060] text-[9px]">Bootstrap p 值（5000 次）</p>
                    <p className={`text-sm font-bold ${sig.pValueBootstrap < 0.05 ? 'text-green-400' : 'text-red-400'}`}>{sig.pValueBootstrap.toFixed(4)}</p>
                  </div>
                </div>
                <p className="text-[#606080] text-[10px]">
                  平均每筆 {signed(sig.mean)}，95% 信賴區間 [{sig.ciLow.toFixed(2)}, {sig.ciHigh.toFixed(2)}]
                  ・雙檢定 {sig.isSignificant ? <span className="text-green-400 font-bold">皆顯著</span> : <span className="text-red-400 font-bold">未達顯著（p 需 &lt; 0.05）</span>}
                </p>

                {/* 樣本外驗證 */}
                <div className="mt-3 pt-3 border-t border-[#1E1E2E]">
                  <p className="text-[#EAEAF4] text-xs font-bold mb-2">{oos.headline}</p>
                  {oos.inSample.nTrades > 0 && oos.inSample.label !== '樣本不足' && (
                    <div className="grid grid-cols-2 gap-1.5 mb-2">
                      {[oos.inSample, oos.outSample].map((seg, i) => (
                        <div key={i} className="bg-[#0A0A0F] rounded-xl p-2.5">
                          <p className="text-[#404060] text-[9px] mb-1">{seg.label}（{seg.nTrades} 筆）</p>
                          <p className={`text-xs font-bold ${seg.expectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>期望值 {signed(seg.expectancy)}</p>
                          <p className="text-[#606080] text-[10px]">勝率 {pct1(seg.winRate)}・p={seg.significance.pValueBootstrap.toFixed(3)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {oos.interpretation.map((s, i) => (
                    <p key={i} className="text-[#606080] text-[10px] leading-4 mb-1">{s}</p>
                  ))}
                </div>
              </div>

              {/* 4. 賭博警訊清單 */}
              {v.redFlags.length > 0 && (
                <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
                  <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">🚩 賭博警訊（{v.redFlags.length}）</p>
                  <div className="space-y-2">
                    {v.redFlags.map((f, i) => (
                      <div key={i} className="flex gap-2">
                        <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full h-fit ${
                          f.severity === 'high' ? 'bg-red-500/20 text-red-400'
                          : f.severity === 'medium' ? 'bg-orange-500/20 text-orange-400'
                          : 'bg-[#1A1A26] text-[#606080]'
                        }`}>
                          {f.severity === 'high' ? '高' : f.severity === 'medium' ? '中' : '低'}
                        </span>
                        <p className="text-[#A0A0C0] text-xs leading-5">{f.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 5. 逐策略體檢 */}
              {result.tagVerdicts.length > 0 && (
                <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
                  <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-1">逐策略體檢（最該砍的排最前）</p>
                  <p className="text-[#404060] text-[9px] mb-2">刻意只列描述統計、不發「優勢認證」— 多標籤各自檢定會把運氣認成優勢（多重比較問題）</p>
                  <div className="space-y-1.5">
                    {result.tagVerdicts.map(tv => (
                      <div key={tv.tag} className="flex items-center gap-2 bg-[#0A0A0F] rounded-xl px-3 py-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-[#EAEAF4] text-xs font-bold truncate">{tv.tag}</p>
                          <p className="text-[#606080] text-[10px]">{tv.nTrades} 筆・勝率 {pct1(tv.winRate)}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-xs font-bold ${tv.isLosing ? 'text-red-400' : 'text-green-400'}`}>{signed(tv.expectancy)}/筆</p>
                          <p className="text-[#606080] text-[10px]">{tagDescriptor(tv)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 跟單/聽明牌抽算 */}
              {result.followGuru && (
                <div className="bg-[#12121A] border border-orange-500/30 rounded-2xl p-4">
                  <p className="text-orange-400 text-[10px] font-bold uppercase tracking-widest mb-2">📢 跟單 / 聽明牌成績單</p>
                  <div className="flex gap-3 mb-2">
                    <span className="text-[#EAEAF4] text-xs">{result.followGuru.nTrades} 筆</span>
                    <span className={`text-xs font-bold ${result.followGuru.expectancy < 0 ? 'text-red-400' : 'text-green-400'}`}>
                      每筆 {signed(result.followGuru.expectancy)}
                    </span>
                    <span className={`text-xs font-bold ${result.followGuru.totalPnl < 0 ? 'text-red-400' : 'text-green-400'}`}>
                      合計 {signed(result.followGuru.totalPnl)}
                    </span>
                  </div>
                  <p className="text-[#A0A0C0] text-xs leading-5">{result.followGuru.message}</p>
                </div>
              )}

              {/* 6. 反事實 + 轉正數字 */}
              {result.counterfactual && (
                <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
                  <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">🔀 反事實：如果停掉最差的「{result.counterfactual.worstTag}」</p>
                  <div className="grid grid-cols-2 gap-1.5 mb-2">
                    <div className="bg-[#0A0A0F] rounded-xl p-2.5 text-center">
                      <p className="text-[#404060] text-[9px]">目前每筆期望值</p>
                      <p className={`text-sm font-bold ${result.counterfactual.beforeExpectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(result.counterfactual.beforeExpectancy)}</p>
                    </div>
                    <div className="bg-[#0A0A0F] rounded-xl p-2.5 text-center">
                      <p className="text-[#404060] text-[9px]">停掉後</p>
                      <p className={`text-sm font-bold ${result.counterfactual.afterExpectancy >= 0 ? 'text-green-400' : 'text-red-400'}`}>{signed(result.counterfactual.afterExpectancy)}</p>
                    </div>
                  </div>
                  <p className="text-[#606080] text-[10px] leading-4">{result.counterfactual.message}</p>
                </div>
              )}

              {result.breakeven.messages.length > 0 && (
                <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-4">
                  <p className="text-[#606080] text-[10px] font-bold uppercase tracking-widest mb-2">🎯 轉正數字 — 具體要改善到哪裡</p>
                  {result.breakeven.messages.map((msg, i) => (
                    <p key={i} className="text-[#A0A0C0] text-xs leading-5 mb-1.5">• {msg}</p>
                  ))}
                </div>
              )}

              {/* 免責聲明 + attribution */}
              <div className="px-3 py-3 bg-[#0D0D16] border border-[#1E1E2E] rounded-2xl">
                <p className="text-[#606080] text-[10px] leading-4">
                  ⚠️ 本工具為統計分析與教育用途，不構成投資建議。統計結論受樣本品質影響，
                  「具統計優勢」也不保證未來獲利；合約與槓桿交易可能導致全部本金損失。
                </p>
                <p className="text-[#404060] text-[10px] mt-2">
                  統計引擎移植自{' '}
                  <a href="https://github.com/mars-tw/anti-gambling-trader-tw" target="_blank" rel="noopener noreferrer" className="text-blue-400 underline">
                    anti-gambling-trader-tw
                  </a>
                  （MIT License）・計算全程在你的瀏覽器本地執行
                </p>
              </div>

              <button onClick={reset} className="w-full py-3 rounded-2xl bg-[#1A1A26] border border-[#1E1E2E] text-[#A0A0C0] text-sm font-bold active:opacity-70">
                ↺ 分析另一份紀錄
              </button>
            </>
          );
        })()}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-[#12121A] border border-[#1E1E2E] rounded-2xl p-2.5 text-center">
      <p className="text-[#404060] text-[9px] mb-0.5">{label}</p>
      <p className="text-sm font-extrabold" style={{ color: color ?? '#EAEAF4' }}>{value}</p>
      {sub && <p className="text-[#404060] text-[8px] mt-0.5">{sub}</p>}
    </div>
  );
}

function fmtShort(x: number): string {
  if (!Number.isFinite(x)) return '∞';
  return x.toFixed(2);
}
