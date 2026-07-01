import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        app: '#0A0A0F',
        surface: '#12121A',
        'surface-alt': '#1A1A26',
        border: '#1E1E2E',
        accent: '#F0B90B',
        'text-p': '#EAEAF4',
        'text-s': '#A0A0C0',
        'text-m': '#606080',
      },
      screens: { xs: '360px' },
    },
  },
  plugins: [],
};

export default config;
