import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-dvh bg-[#0A0D11] flex flex-col items-center justify-center px-8 text-center gap-6">
      <div className="text-[#3A424E] text-2xl num">[ ? ]</div>
      <div>
        <h2 className="text-[#E8ECF1] text-lg font-medium mb-2">頁面不存在</h2>
        <p className="text-[#565E6B] text-sm">找不到你要的頁面</p>
      </div>
      <Link href="/" className="btn-primary px-8 py-3 rounded inline-block">
        回到首頁
      </Link>
    </div>
  );
}
