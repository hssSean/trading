import { createClient } from '@supabase/supabase-js';

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL  || 'https://placeholder.supabase.co';
const key  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const supabase = createClient(url, key);

/** Upload a canvas screenshot to Supabase Storage, return public URL */
export async function uploadChartScreenshot(
  userId: string,
  tradeId: string,
  tag: 'entry' | 'exit',
  canvas: HTMLCanvasElement,
): Promise<string | null> {
  return new Promise(resolve => {
    canvas.toBlob(async (blob) => {
      if (!blob) { resolve(null); return; }
      const path = `${userId}/${tradeId}-${tag}.png`;
      const { error } = await supabase.storage
        .from('trade-charts')
        .upload(path, blob, { upsert: true, contentType: 'image/png' });
      if (error) { resolve(null); return; }
      const { data } = supabase.storage.from('trade-charts').getPublicUrl(path);
      resolve(data.publicUrl);
    }, 'image/png');
  });
}
