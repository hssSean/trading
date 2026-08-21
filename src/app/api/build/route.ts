import { NextResponse } from 'next/server';

// 回報「目前部署的是哪一版」。客戶端拿它跟自己 bundle 裡打死的
// NEXT_PUBLIC_BUILD_SHA 比對，不同就代表這個分頁在跑舊程式碼。
// 說明見 src/lib/buildVersion.ts。
//
// 一定要 force-dynamic + no-store：這個端點的全部價值就在於「永遠是最新的」，
// 被任何一層快取住就完全失效，而且失效方式是靜默的（永遠回報舊 sha，於是
// 永遠不提示更新），比壞掉還糟。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(
    { sha: process.env.VERCEL_GIT_COMMIT_SHA ?? '' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
