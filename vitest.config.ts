import { defineConfig } from 'vitest/config';
import path from 'path';

// Mirrors tsconfig.json's "@/*": ["./src/*"] — without this, vitest (no
// webpack/Next.js resolver behind it) can't resolve "@/..." imports, forcing
// every src/ file to fall back to relative paths the moment it needs to
// cross-import outside its own folder (first hit: src/engine importing
// src/lib/monitorMath — everything else in src/ already used "@/" freely).
export default defineConfig({
  // tsconfig 的 jsx 是 Next.js 要的 "preserve"；vitest 沒有 Next 的編譯器，要自己把 .tsx 轉成 React 呼叫
  // （2026-10-04 第一次有元件測試：tests/paperStratCard.test.ts）。
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
