'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [mode,  setMode]  = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [pass,  setPass]  = useState('');
  const [err,   setErr]   = useState('');
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    setErr(''); setLoading(true);
    try {
      const { error } = mode === 'login'
        ? await supabase.auth.signInWithPassword({ email, password: pass })
        : await supabase.auth.signUp({ email, password: pass });
      if (error) { setErr(error.message); return; }
      if (mode === 'signup') {
        setErr(''); setMode('login');
        alert('帳號建立成功！請用 Email 和密碼登入。');
        return;
      }
      router.replace('/');
    } catch {
      setErr('網路錯誤，請重試');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-[#0A0A0F] flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📈</div>
          <h1 className="text-[#EAEAF4] text-2xl font-extrabold">Crypto Trader</h1>
          <p className="text-[#606080] text-sm mt-1">加密貨幣交易信號分析</p>
        </div>

        <div className="card">
          <div className="flex gap-2 mb-5">
            {(['login', 'signup'] as const).map(m => (
              <button key={m} onClick={() => { setMode(m); setErr(''); }}
                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${
                  mode === m ? 'bg-[#F0B90B] text-[#0A0A0F]' : 'bg-[#1A1A26] text-[#606080]'
                }`}>
                {m === 'login' ? '登入' : '註冊'}
              </button>
            ))}
          </div>

          <p className="text-[#606080] text-xs mb-1">Email</p>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            placeholder="your@email.com"
            className="input-field mb-3"
            onKeyDown={e => e.key === 'Enter' && handle()}
          />

          <p className="text-[#606080] text-xs mb-1">密碼{mode === 'signup' ? '（至少 6 位）' : ''}</p>
          <input
            value={pass}
            onChange={e => setPass(e.target.value)}
            type="password"
            placeholder="••••••••"
            className="input-field mb-4"
            onKeyDown={e => e.key === 'Enter' && handle()}
          />

          {err && <p className="text-red-400 text-xs mb-3 bg-red-500/10 rounded-lg px-3 py-2">{err}</p>}

          <button
            onClick={handle}
            disabled={!email || !pass || loading}
            className="w-full py-3 rounded-xl btn-primary font-bold text-sm disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#0A0A0F] border-t-transparent rounded-full animate-spin" />
                {mode === 'login' ? '登入中…' : '建立帳號…'}
              </span>
            ) : mode === 'login' ? '登入' : '建立帳號'}
          </button>
        </div>

        <p className="text-[#404060] text-xs text-center mt-6 leading-5">
          資料儲存於個人帳號，換裝置登入即可同步<br />
          <span className="text-red-400/60">本 App 僅供參考，不構成投資建議</span>
        </p>
      </div>
    </div>
  );
}
