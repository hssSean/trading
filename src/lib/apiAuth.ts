// /api/s3/* 共用：驗證登入（Supabase JWT，跟 /api/reject-funnel 同一種模式）與取得 Redis。
import type { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

/** 回登入者的 user id；沒登入或驗證失敗回 null */
export async function checkUserSession(req: NextRequest): Promise<string | null> {
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return null;
  const c = createClient(url, key, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error } = await c.auth.getUser();
  return !error && user ? user.id : null;
}

export function getRedisOrNull(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export const parseJson = <T,>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
