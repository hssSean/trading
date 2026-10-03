import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaperStratCard } from '../src/components/PaperStratCard';
import { summarizePaper } from '../src/lib/paper/stats';

const D = 86_400_000;

// /paper 頁面需要真的 Supabase 登入才能在瀏覽器預覽；卡片本身用假資料直接渲染驗證。
describe('PaperStratCard', () => {
  const recsA = [
    { id: 'BTCUSDT:1', status: 'done', symbol: 'BTCUSDT', entryT: 1, signalT: 1, entry: 65000, stop: 62000, netR: 2.15, grossR: 2.2, exitT: 3, exitReason: 'ema', partial: true },
    { id: 'ETHUSDT:2', status: 'open', symbol: 'ETHUSDT', entryT: 2, signalT: 2, entry: 2400, stop: 2300, partial: false },
    { id: 'SOLUSDT:3', status: 'pending', symbol: 'SOLUSDT', entryT: 3, signalT: 3, stop: 80 },
  ];

  it('renders summary numbers, spec comparison and progress text', () => {
    const html = renderToStaticMarkup(createElement(PaperStratCard, { summary: summarizePaper('strategyA', recsA, 0, 7 * D), recent: recsA }));
    expect(html).toContain('策略 A｜日線 Keltner 突破');
    expect(html).toContain('+2.15R');          // 每筆淨
    expect(html).toContain('回測 +0.35R');
    expect(html).toContain('還不能判（1/50 筆）');
    expect(html).toContain('看最近紀錄（3）');
    expect(html).not.toContain('BTC');         // 預設收起
  });

  it('expanded list shows each record with status, side and exit reason', () => {
    const html = renderToStaticMarkup(createElement(PaperStratCard, { summary: summarizePaper('strategyA', recsA, 0, 7 * D), recent: recsA, defaultOpen: true }));
    expect(html).toContain('BTC');
    expect(html).toContain('跌破 EMA20 出場');
    expect(html).toContain('已平 1/3');
    expect(html).toContain('持倉中');
    expect(html).toContain('等待成交');
  });

  it('video records show limit/market, target price, short side and hidden-count note', () => {
    const recs = [
      { id: 'X:1:-1', status: 'done', symbol: 'HYPEUSDT', startT: 1, side: -1, kind: 1, price: 89.1, entry: 89.1, sl: 90.2, tp: 85.8, netR: -1.07, grossR: -1, exitT: 2, exitKind: 'stop' },
      { id: 'X:2:1', status: 'busy', symbol: 'HYPEUSDT', startT: 2, side: 1, kind: 0, price: 88, sl: 87, tp: 91 },
    ];
    const html = renderToStaticMarkup(createElement(PaperStratCard, { summary: summarizePaper('videoA', recs, 0, 7 * D), recent: recs.slice(0, 1), defaultOpen: true }));
    expect(html).toContain('HYPE');
    expect(html).toContain('空');
    expect(html).toContain('限價');
    expect(html).toContain('盈 85.80');
    expect(html).toContain('-1.07R');
    expect(html).toContain('止損');
    expect(html).toContain('已有持倉略過 1 筆未列出');
  });
});
