// 2026-10-07 起策略帳戶拆成「帳本」分頁（/ledgers）；舊連結轉過去。
import { redirect } from 'next/navigation';

export default function StrategiesRedirect() {
  redirect('/ledgers');
}
