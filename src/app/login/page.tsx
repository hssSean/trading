'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { FormField } from '@/components/ui/FormField';
import { ToggleChip } from '@/components/ui/ToggleChip';

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
    <div className="min-h-dvh bg-app flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📈</div>
          <h1 className="text-text-p text-2xl font-extrabold">Crypto Trader</h1>
          <p className="text-text-m text-sm mt-1">加密貨幣交易信號分析</p>
        </div>

        <div className="bg-card-2 border border-white/[0.06] rounded-xl p-4">
          <div className="flex gap-2 mb-5">
            {(['login', 'signup'] as const).map(m => (
              <ToggleChip
                key={m}
                label={m === 'login' ? '登入' : '註冊'}
                active={mode === m}
                onClick={() => { setMode(m); setErr(''); }}
              />
            ))}
          </div>

          <div onKeyDown={e => e.key === 'Enter' && handle()} className="mb-1">
            <FormField
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="your@email.com"
            />
          </div>

          <div onKeyDown={e => e.key === 'Enter' && handle()} className="mt-3 mb-1">
            <FormField
              label={`密碼${mode === 'signup' ? '（至少 6 位）' : ''}`}
              type="password"
              value={pass}
              onChange={setPass}
              placeholder="••••••••"
            />
          </div>

          {err && <p className="text-down text-xs mt-3 bg-down/10 rounded-lg px-3 py-2">{err}</p>}

          <button
            onClick={handle}
            disabled={!email || !pass || loading}
            className="w-full py-3 mt-4 rounded-xl btn-primary font-bold text-sm disabled:opacity-40"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-[#0A0D11] border-t-transparent rounded-full animate-spin" />
                {mode === 'login' ? '登入中…' : '建立帳號…'}
              </span>
            ) : mode === 'login' ? '登入' : '建立帳號'}
          </button>
        </div>

        <p className="text-text-m text-xs text-center mt-6 leading-5">
          資料儲存於個人帳號，換裝置登入即可同步<br />
          <span className="text-down/60">本 App 僅供參考，不構成投資建議</span>
        </p>
      </div>
    </div>
  );
}
