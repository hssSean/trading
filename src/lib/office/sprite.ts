// Clawd 像素員工的矩形清單（單位：格）。移植自使用者的桌寵 ~/.claude/desktop-pet/pet.py（draw_clawd 等）。
// 純函數：同樣的 state／t 永遠畫出同樣的圖；眨眼與視線由呼叫端傳入。測試在 tests/officeSprite.test.ts。
import type { Accessory, SeatState } from './seats';

export interface PxRect { x: number; y: number; w: number; h: number; fill: string }
export interface Palette { body: string; dark: string }
export const PALETTE_DEFAULT: Palette = { body: '#de8a6c', dark: '#c4704f' };
export const PALETTE_SHORT: Palette = { body: '#a98bd8', dark: '#8a6cbc' };
export const SPRITE_W = 20;
export const SPRITE_H = 22;

const EYE = '#141414';
const TERM_BG = '#23222f', TERM_BAR = '#33323f';
const CODE = ['#5fd068', '#5fd068', '#7fb2ff', '#e6c35c', '#c792ea'];
const KEYB = '#5c7682', KEYB_KEY = '#8aa3ad';
const RED = '#ff4a1c', ZZZ = '#9aa4b2';
const OX = 4, OY = 11;   // 身體左上角

/** 灰階：unknown 狀態用 */
const gray = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const y = Math.round(0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255));
  const h = y.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
};

/** 終端機的程式碼行：用 t 決定捲動，不用亂數（純函數） */
function codeLines(t: number): { len: number; col: string; ind: number }[] {
  const step = Math.floor(t / 0.35);
  return Array.from({ length: 5 }, (_, i) => {
    const k = step + i;
    return { len: 3 + ((k * 7) % 9), col: CODE[(k * 3) % CODE.length], ind: (k * 5) % 3 };
  });
}

export function clawdRects(o: { state: SeatState; accessory: Accessory; palette: Palette; t: number; look: [number, number]; blink: boolean }): PxRect[] {
  const { state, t, look, blink } = o;
  const { body: BODY, dark: DARK } = o.palette;
  const out: PxRect[] = [];
  const px = (c: number, r: number, w = 1, h = 1, fill = BODY) => out.push({ x: OX + c, y: OY + r, w, h, fill });
  const abs = (x: number, y: number, w: number, h: number, fill: string) => out.push({ x, y, w, h, fill });

  // 背後的終端機（工作中）
  if (state === 'working') {
    abs(OX - 1, OY - 10, 14, 9, TERM_BG);
    abs(OX - 1, OY - 10, 14, 1, TERM_BAR);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => abs(OX - 0.6 + i * 0.9, OY - 9.75, 0.5, 0.5, c));
    const lines = codeLines(t);
    lines.forEach((l, i) => {
      let len = Math.min(l.len, 12 - l.ind);
      if (i === lines.length - 1) len = Math.max(1, Math.floor(len * (((t * 3) % 1) + 0.2)));
      abs(OX - 0.2 + l.ind * 0.8, OY - 8.4 + i * 1.4, Math.min(len * 0.8, 12.4 - l.ind * 0.8), 0.7, l.col);
    });
  }

  // 腳
  [1, 3, 8, 10].forEach((c, i) => {
    const lift = state === 'alert' && Math.floor(t * 6) % 2 === i % 2 ? 0.5 : 0;
    px(c, 7 - lift, 1, 2, i === 1 || i === 2 ? DARK : BODY);
  });
  // 身體
  px(0, 0, 12, 7);
  px(0, 6.5, 12, 0.5, DARK);

  // 手
  if (state === 'celebrate') {
    const up = Math.floor(t * 4) % 2;
    px(-2, 2 - up, 2, 1); px(-2, 1 - up, 1, 1);
    px(12, 1 + up, 2, 1); px(13, up, 1, 1);
  } else if (state === 'alert') {
    const wave = Math.floor(t * 6) % 2;
    px(-2, 3, 2, 1);
    px(12, 1 + wave, 2, 1); px(13, wave, 1, 1);
  } else if (state !== 'working') {
    px(-2, 3, 2, 2); px(12, 3, 2, 2);
  }

  // 眼睛
  if (state === 'idle' || state === 'unknown') {
    for (const c of [2, 9]) px(c - 0.5, 3.5, 2, 0.5, EYE);
  } else if (state === 'celebrate') {
    for (const c of [2, 9]) { px(c - 0.5, 3, 0.5, 0.5, EYE); px(c, 2.5, 1, 0.5, EYE); px(c + 1, 3, 0.5, 0.5, EYE); }
  } else if (blink) {
    for (const c of [2, 9]) px(c, 3, 1, 0.5, EYE);
  } else {
    const [ex, ey] = state === 'working' ? [0, 0.5] : state === 'alert' ? [0, 0] : look;
    for (const c of [2, 9]) px(c + ex, 2 + ey, 1, 2, EYE);
  }

  // 配件
  switch (o.accessory) {
    case 'tie': px(5.5, 4.5, 1, 0.5, '#2b4c7e'); px(5.25, 5, 1.5, 1.5, '#2b4c7e'); break;
    case 'scope': px(9, -1.5, 4.5, 1.25, '#4a4a5a'); px(9, -1.5, 4.5, 0.4, '#6a6a7e'); px(13.25, -1.75, 0.75, 1.75, '#7fb2ff'); break;
    case 'badgeA': case 'badgeB':
      px(4.5, 4.5, 3, 2, '#f4f1e8');
      px(5.5, 5, 1, 1, o.accessory === 'badgeA' ? '#d9534f' : '#2b7bd9'); break;
    case 'clock': px(4.5, -2, 3, 2, '#f4f1e8'); px(5.75, -1.75, 0.5, 1, EYE); px(6, -1, 1, 0.5, EYE); break;
    case 'short': px(4.5, 4.5, 3, 1, '#2c2c3a'); px(5, 5.5, 2, 1, '#2c2c3a'); break;
    case 'calendar': px(4.5, -2.5, 3, 2.5, '#f4f1e8'); px(4.5, -2.5, 3, 0.75, '#d9534f'); break;
    case 'shield': px(4.5, 4, 3, 2, '#3c8dbc'); px(5, 6, 2, 0.5, '#3c8dbc'); px(5.75, 4.5, 0.5, 1.5, '#e8ecf1'); break;
  }

  // 前方的鍵盤＋打字的手（工作中）
  if (state === 'working') {
    abs(OX - 1.5, OY + 4.5, 15, 2.5, KEYB);
    for (let row = 0; row < 2; row++) for (let col = 0; col < 13; col++) {
      abs(OX - 1.2 + col * 1.08, OY + 4.8 + row * 1.05, 0.75, 0.7, KEYB_KEY);
    }
    const tap = Math.floor(t * 8) % 2;
    px(-1, 3.5 + tap * 0.5, 2, 1); px(11, 3.5 + (1 - tap) * 0.5, 2, 1);
  }

  // 驚嘆號（閃爍）
  if (state === 'alert' && Math.floor(t * 4) % 2 === 0) {
    abs(OX + 14.5, OY - 5, 1.5, 4, RED);
    abs(OX + 14.5, OY, 1.5, 1.5, RED);
  }

  // zzz
  if (state === 'idle') {
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.6 + i / 3) % 1;
      const s = 0.5 + i * 0.25;
      abs(OX + 12.5 + ph * 2, OY - 2 - ph * 6, s, s, ZZZ);
    }
  }

  if (state === 'unknown') return out.map(r => ({ ...r, fill: gray(r.fill) }));
  return out;
}
