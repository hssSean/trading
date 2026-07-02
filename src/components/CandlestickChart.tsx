'use client';

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Candle, TradingSignal, SRLevel, OrderBlock } from '@/types';
import { ema as emaCalc } from '@/analysis/indicators';

interface Props {
  candles:      Candle[];
  signals?:     TradingSignal[];
  srLevels?:    SRLevel[];
  orderBlocks?: OrderBlock[];
  height?:      number;
}

export interface CandlestickChartRef {
  takeScreenshot: () => HTMLCanvasElement | null;
}

export const CandlestickChart = forwardRef<CandlestickChartRef, Props>(function CandlestickChart({
  candles,
  signals      = [],
  srLevels     = [],
  orderBlocks  = [],
  height       = 320,
}: Props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<unknown>(null);

  useImperativeHandle(ref, () => ({
    takeScreenshot: () => (chartRef.current as any)?.takeScreenshot() ?? null,
  }));

  useEffect(() => {
    if (!containerRef.current || candles.length < 10) return;
    let unmounted = false;
    let roDisconnect: (() => void) | undefined;

    (async () => {
      const {
        createChart, ColorType, CrosshairMode, LineStyle,
      } = await import('lightweight-charts');
      if (unmounted || !containerRef.current) return;

      // Destroy previous instance
      (chartRef.current as any)?.remove();
      chartRef.current = null;

      const el    = containerRef.current;
      const chart = createChart(el, {
        width:  el.clientWidth,
        height,
        layout: {
          background: { type: ColorType.Solid, color: '#0A0A0F' },
          textColor:  '#A0A0C0',
          fontSize:   11,
        },
        grid: {
          vertLines: { color: '#1A1A26' },
          horzLines: { color: '#1A1A26' },
        },
        crosshair:       { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1E1E2E', minimumWidth: 72 },
        timeScale: {
          borderColor:    '#1E1E2E',
          timeVisible:    true,
          secondsVisible: false,
        },
        handleScale:  { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
        handleScroll: { vertTouchDrag: true, pressedMouseMove: true, horzTouchDrag: true },
      });
      chartRef.current = chart;

      // ── Candlestick series ────────────────────────────────────
      const cs = chart.addCandlestickSeries({
        upColor:      '#00C851',
        downColor:    '#FF4444',
        borderVisible: false,
        wickUpColor:   '#00C851',
        wickDownColor: '#FF4444',
      });
      cs.setData(candles.map(c => ({
        time:  Math.floor(c.openTime / 1000) as any,
        open:  c.open,
        high:  c.high,
        low:   c.low,
        close: c.close,
      })));

      // ── EMA overlay lines ─────────────────────────────────────
      const closes = candles.map(c => c.close);
      const e20    = emaCalc(closes, 20);
      const e50    = emaCalc(closes, 50);
      const e200   = emaCalc(closes, 200);

      const toLine = (vals: number[]) =>
        candles
          .map((c, i) => isNaN(vals[i]) ? null : { time: Math.floor(c.openTime / 1000) as any, value: vals[i] })
          .filter(Boolean) as any[];

      chart.addLineSeries({ color: '#F0B90B55', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(toLine(e20));
      chart.addLineSeries({ color: '#60A5FA55', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(toLine(e50));
      chart.addLineSeries({ color: '#A855F7',   lineWidth: 2, priceLineVisible: false, lastValueVisible: true,  crosshairMarkerVisible: false }).setData(toLine(e200));

      // ── S/R price lines ───────────────────────────────────────
      srLevels.slice(0, 8).forEach(l => {
        cs.createPriceLine({
          price:            l.price,
          color:            l.type === 'support' ? '#00C85175' : '#FF444475',
          lineWidth:        1,
          lineStyle:        LineStyle.Dotted,
          axisLabelVisible: true,
          title:            `${l.type === 'support' ? 'S' : 'R'}×${l.touchCount}`,
        });
      });

      // ── Order block zone boundaries ───────────────────────────
      orderBlocks.slice(0, 4).forEach(ob => {
        const col = ob.type === 'bullish' ? '#00C851' : '#FF4444';
        cs.createPriceLine({ price: ob.high, color: `${col}55`, lineWidth: 1, lineStyle: LineStyle.Solid,  axisLabelVisible: false, title: ob.type === 'bullish' ? 'OB▲' : '' });
        cs.createPriceLine({ price: ob.low,  color: `${col}33`, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: ob.type === 'bearish' ? 'OB▼' : '' });
      });

      // ── Best signal lines & arrow marker ─────────────────────
      if (signals.length > 0) {
        const sig = signals.reduce((a, b) => b.score > a.score ? b : a);
        const col = sig.direction === 'LONG' ? '#3B82F6' : '#C084FC';

        cs.createPriceLine({ price: sig.entry,   color: col,       lineWidth: 2, lineStyle: LineStyle.Solid,  axisLabelVisible: true, title: '入場' });
        cs.createPriceLine({ price: sig.stopLoss, color: '#FF4444', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'SL'  });
        if (sig.takeProfits[0]) cs.createPriceLine({ price: sig.takeProfits[0], color: '#00C851', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'TP1' });
        if (sig.takeProfits[1]) cs.createPriceLine({ price: sig.takeProfits[1], color: '#00A040', lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'TP2' });

        cs.setMarkers([{
          time:     Math.floor(candles[candles.length - 1].openTime / 1000) as any,
          position: sig.direction === 'LONG' ? 'belowBar' : 'aboveBar',
          color:    col,
          shape:    sig.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
          text:     `${sig.direction === 'LONG' ? '▲' : '▼'} ${sig.score}pt`,
          size:     2,
        }]);
      }

      chart.timeScale().fitContent();

      // ── Responsive resize ─────────────────────────────────────
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width;
        if (w) chart.applyOptions({ width: w });
      });
      ro.observe(el);
      roDisconnect = () => ro.disconnect();
    })();

    return () => {
      unmounted = true;
      roDisconnect?.();
      (chartRef.current as any)?.remove();
      chartRef.current = null;
    };
  }, [candles, signals, srLevels, orderBlocks, height]);

  if (candles.length === 0) return null;

  return (
    <div className="w-full">
      <div ref={containerRef} style={{ height }} className="w-full" />
      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-2 pb-1 px-3">
        {[
          { color: '#F0B90B', label: 'EMA20' },
          { color: '#60A5FA', label: 'EMA50' },
          { color: '#A855F7', label: 'EMA200' },
          { color: '#00C851', label: '支撐', dot: true },
          { color: '#FF4444', label: '阻力', dot: true },
          { color: '#3B82F6', label: 'OB▲',  dot: true },
          { color: '#FF4444', label: 'OB▼',  dot: true },
        ].map(({ color, label, dot }) => (
          <span key={label} className="flex items-center gap-1 text-[9px] text-[#404060]">
            {dot
              ? <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
              : <span className="w-4 h-px"                 style={{ background: color }} />
            }
            {label}
          </span>
        ))}
      </div>
    </div>
  );
});
