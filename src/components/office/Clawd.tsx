'use client';
// Clawd 像素員工（SVG）。圖形邏輯在 src/lib/office/sprite.ts。
import { memo } from 'react';
import { clawdRects, PALETTE_DEFAULT, PALETTE_SHORT, SPRITE_H, SPRITE_W } from '@/lib/office/sprite';
import type { Accessory, SeatState } from '@/lib/office/seats';

export const Clawd = memo(function Clawd({ state, accessory, t, look = [0, 0], blink = false, size = 80 }: {
  state: SeatState; accessory: Accessory; t: number; look?: [number, number]; blink?: boolean; size?: number;
}) {
  const rects = clawdRects({ state, accessory, t, look, blink, palette: accessory === 'short' ? PALETTE_SHORT : PALETTE_DEFAULT });
  return (
    <svg viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`} width={size} height={(size * SPRITE_H) / SPRITE_W} shapeRendering="crispEdges" aria-hidden>
      {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />)}
    </svg>
  );
});
