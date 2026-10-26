// Tanda tangan URL media (episodes.url, series.thumbnail_url/meta_url) utk media.kilasdrama.online.
// Dipanggil tiap kali link dikirim ke pemain/konsumen -- JANGAN disimpan ke DB atau cache lama.
// Rahasia hanya dari env MEDIA_SIGNING_SECRET (.env), tidak pernah ditulis di kode/log.
import { createHmac } from 'node:crypto';

const SIGNED_HOST = 'media.kilasdrama.online';

export function signMedia(url, ttl = 7200) {
  if (!url) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (u.hostname !== SIGNED_HOST) return url; // host lain (mis. media.flicka.id) tidak ditandatangani
  const secret = process.env.MEDIA_SIGNING_SECRET;
  if (!secret) throw new Error('MEDIA_SIGNING_SECRET belum diisi di .env');
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = createHmac('sha256', secret).update(`${u.pathname}.${exp}`).digest('base64url');
  return `${url}?exp=${exp}&sig=${sig}`;
}
