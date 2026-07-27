/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel sets VERCEL_GIT_COMMIT_SHA at build time but doesn't expose it to the client;
  // mapping it to a NEXT_PUBLIC_ var lets the settings page show which build is actually
  // running — a PWA tab can sit open on a stale bundle for days (待修改事項.md P2-4).
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [{ key: 'Service-Worker-Allowed', value: '/' }],
      },
    ];
  },
};

export default nextConfig;
