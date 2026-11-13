import { describe, expect, it } from 'vitest';
import { clawdRects, PALETTE_DEFAULT, PALETTE_SHORT, SPRITE_H, SPRITE_W } from '@/lib/office/sprite';

const base = { accessory: 'tie' as const, palette: PALETTE_DEFAULT, t: 0, look: [0, 0] as [number, number], blink: false };
const has = (rs: ReturnType<typeof clawdRects>, fill: string) => rs.some(r => r.fill === fill);

describe('clawdRects', () => {
  it('所有矩形都在 viewBox 內', () => {
    for (const state of ['working', 'celebrate', 'alert', 'idle', 'unknown'] as const) {
      for (const t of [0, 0.13, 0.5, 1.7]) {
        for (const r of clawdRects({ ...base, state, t })) {
          expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(SPRITE_W); expect(r.y + r.h).toBeLessThanOrEqual(SPRITE_H);
        }
      }
    }
  });

  it('working 有終端機底色與鍵盤', () => {
    const rs = clawdRects({ ...base, state: 'working' });
    expect(has(rs, '#23222f')).toBe(true);
    expect(has(rs, '#5c7682')).toBe(true);
  });

  it('alert 有紅色驚嘆號（閃爍的亮相位）', () => {
    expect(has(clawdRects({ ...base, state: 'alert', t: 0 }), '#ff4a1c')).toBe(true);
  });

  it('idle 沒有終端機、有 zzz', () => {
    const rs = clawdRects({ ...base, state: 'idle', t: 0.3 });
    expect(has(rs, '#23222f')).toBe(false);
    expect(has(rs, '#9aa4b2')).toBe(true);
  });

  it('unknown 全部灰階', () => {
    const rs = clawdRects({ ...base, state: 'unknown' });
    expect(rs.every(r => /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$|^#([0-9a-f]{2})\4\4$/i.test(r.fill))).toBe(true);
  });

  it('palette 換色會換身體顏色', () => {
    expect(has(clawdRects({ ...base, state: 'idle', palette: PALETTE_SHORT }), PALETTE_SHORT.body)).toBe(true);
    expect(has(clawdRects({ ...base, state: 'idle', palette: PALETTE_SHORT }), PALETTE_DEFAULT.body)).toBe(false);
  });

  it('同樣輸入同樣輸出（純函數）', () => {
    expect(clawdRects({ ...base, state: 'working', t: 0.4 })).toEqual(clawdRects({ ...base, state: 'working', t: 0.4 }));
  });
});
