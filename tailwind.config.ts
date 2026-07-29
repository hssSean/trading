import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        app: '#0B0E12',
        surface: '#12161C',
        'surface-alt': '#1A2029',
        border: '#222A35',
        'border-strong': '#2A323D',
        accent: '#2DD4BF',
        up: '#0ECB81',
        down: '#F6465D',
        'text-p': '#EAEDF2',
        'text-s': '#97A2B0',
        'text-m': '#59616E',
        // Unify P&L greens/reds app-wide (deep-merged over Tailwind defaults so
        // every existing text-green-400 / bg-red-500/10 picks up the new shades).
        green: { 300: '#3DDC97', 400: '#0ECB81', 500: '#0ECB81', 600: '#0BA36A' },
        red: { 300: '#F87088', 400: '#F6465D', 500: '#F6465D', 600: '#D93A4E' },
        'card-2': '#141922',
        'card-2-alt': '#12161C',
      },
      borderRadius: {
        'card-lg': '20px',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SF Mono', 'JetBrains Mono', 'Menlo', 'monospace'],
      },
      screens: { xs: '360px' },
    },
  },
  plugins: [],
};

export default config;
