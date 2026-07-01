import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-dvh bg-[#0A0A0F] flex flex-col items-center justify-center px-8 text-center gap-6">
      <div className="text-5xl">🔍</div>
      <div>
        <h2 className="text-[#EAEAF4] text-lg font-bold mb-2">頁面不存在</h2>
        <p className="text-[#606080] text-sm">找不到你要的頁面</p>
      </div>
      <Link href="/" className="btn-primary px-8 py-3 rounded-2xl inline-block">
        回到首頁
      </Link>
    </div>
  );
}
