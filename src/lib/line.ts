import { TradingSignal } from '@/types';

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

function strengthLabel(s: string): string {
  return s === 'STRONG' ? '強勢 ★★★' : s === 'MODERATE' ? '中等 ★★' : '普通 ★';
}

// ── LINE Flex Message bubble for a trading signal ──
export function buildLineFlexMessage(signal: TradingSignal): object {
  const isLong = signal.direction === 'LONG';
  const accentColor = isLong ? '#00C851' : '#FF4444';
  const headerBg = isLong ? '#0A1F0F' : '#1F0A0A';
  const dirLabel = isLong ? '▲  做多  LONG' : '▼  做空  SHORT';
  const tp1 = signal.takeProfits[0];
  const tp2 = signal.takeProfits[1];
  const coin = signal.symbol.replace('USDT', '/USDT');
  const timeStr = new Date(signal.timestamp).toLocaleString('zh-TW', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: headerBg,
      paddingAll: '16px',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            {
              type: 'text',
              text: dirLabel,
              weight: 'bold',
              size: 'lg',
              color: accentColor,
              flex: 3,
            },
            {
              type: 'text',
              text: coin,
              weight: 'bold',
              size: 'lg',
              color: '#FFFFFF',
              align: 'end',
              flex: 2,
            },
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'sm',
          contents: [
            {
              type: 'text',
              text: `${signal.timeframe} 週期`,
              size: 'xs',
              color: '#888888',
            },
            {
              type: 'text',
              text: `${strengthLabel(signal.strength)}  ${signal.score}pt`,
              size: 'xs',
              color: '#F0B90B',
              align: 'end',
            },
          ],
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      backgroundColor: '#111111',
      paddingAll: '16px',
      contents: [
        priceRow('📌 入場價', `$${fmtPrice(signal.entry)}`, '#EAEAF4'),
        priceRow('🎯 止盈 TP1', `$${fmtPrice(tp1)}`, '#00C851'),
        ...(tp2 ? [priceRow('🎯 止盈 TP2', `$${fmtPrice(tp2)}`, '#00A040')] : []),
        priceRow('🛑 止損 SL', `$${fmtPrice(signal.stopLoss)}`, '#FF4444'),
        { type: 'separator', margin: 'md', color: '#333333' },
        {
          type: 'box',
          layout: 'horizontal',
          margin: 'md',
          spacing: 'sm',
          contents: [
            statBox('風險回報比', `${signal.riskReward}:1`),
            statBox('分析得分', `${signal.score} 分`),
          ],
        },
        { type: 'separator', margin: 'md', color: '#333333' },
        {
          type: 'text',
          text: '分析依據',
          size: 'xxs',
          color: '#666666',
          margin: 'md',
        },
        ...signal.reasons.slice(0, 5).map((r) => ({
          type: 'text' as const,
          text: `• ${r}`,
          size: 'xxs',
          color: '#AAAAAA',
          wrap: true,
        })),
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#0A0A0A',
      paddingAll: '10px',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '📊 查看 TradingView 圖表',
            uri: `https://www.tradingview.com/chart/?symbol=BINANCE%3A${signal.symbol}`,
          },
          style: 'secondary',
          height: 'sm',
          color: '#1A2A3A',
        },
        {
          type: 'text',
          text: `Crypto Trader  ·  ${timeStr}`,
          size: 'xxs',
          color: '#555555',
          align: 'center',
        },
      ],
    },
  };
}

function priceRow(label: string, value: string, color: string): object {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 3 },
      { type: 'text', text: value, size: 'sm', color, weight: 'bold', align: 'end', flex: 4, adjustMode: 'shrink-to-fit' },
    ],
  };
}

function statBox(label: string, value: string): object {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    backgroundColor: '#1A1A2E',
    cornerRadius: 'md',
    paddingAll: 'sm',
    contents: [
      { type: 'text', text: label, size: 'xxs', color: '#888888', align: 'center' },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: '#F0B90B', align: 'center', margin: 'xs' },
    ],
  };
}

// ── Send a raw LINE push message ──
export async function sendLineMessage(
  channelToken: string,
  userId: string,
  messages: object[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelToken}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Send a trading signal as a Flex Message ──
export async function sendSignalToLine(
  signal: TradingSignal,
  channelToken: string,
  userId: string,
): Promise<boolean> {
  const flex = buildLineFlexMessage(signal);
  const altText = `${signal.direction === 'LONG' ? '做多▲' : '做空▼'} ${signal.symbol.replace('USDT', '/USDT')}｜入場 $${fmtPrice(signal.entry)}｜RR ${signal.riskReward}:1`;
  const { ok } = await sendLineMessage(channelToken, userId, [
    { type: 'flex', altText, contents: flex },
  ]);
  return ok;
}
