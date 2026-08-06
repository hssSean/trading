import { defineConfig } from 'vitest/config';
import path from 'path';

// Mirrors tsconfig.json's "@/*": ["./src/*"] — without this, vitest (no
// webpack/Next.js resolver behind it) can't resolve "@/..." imports, forcing
// every src/ file to fall back to relative paths the moment it needs to
// cross-import outside its own folder (first hit: src/engine importing
// src/lib/monitorMath — everything else in src/ already used "@/" freely).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
