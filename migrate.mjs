// Migrasi semua object Cloudflare R2 -> Backblaze B2 (S3 API), struktur folder/key persis sama.
//   node --env-file=.env migrate.mjs              dry-run (default): bandingkan R2 vs B2, tidak ada yang disalin
//   node --env-file=.env migrate.mjs --run        salin yang belum ada di B2 (lalu verifikasi otomatis)
//   node --env-file=.env migrate.mjs --verify     cek saja: ukuran + ETag(MD5) R2 vs B2 cocok semua?
//   node --env-file=.env migrate.mjs --db         rencana ubah database pusat (lewat API): link R2 -> URL baru di B2 (tidak menulis)
//   node --env-file=.env migrate.mjs --db --run   ubah database pusat lewat API. Dipanggil otomatis di akhir --run kalau NEW_PUBLIC_URL diisi
//   Database diubah hanya untuk object yang SUDAH ada di B2; yang belum dibiarkan. Aman diulang.
//   env tambahan: API_URL, NEW_PUBLIC_URL (URL publik baru untuk object di B2), R2_PUBLIC_URL (URL lama; atau OLD_PUBLIC_URL)
// opsi: --prefix=series/   batasi ke satu folder     --c=8   jumlah unduh/unggah paralel (default 8)
//       --overwrite        timpa object B2 yang ukurannya BEDA (default: dilewati dan dilaporkan sebagai bentrok)
// Tidak pernah menghapus apa pun, baik di R2 maupun di B2. Aman diulang (yang sudah sama dilewati).
//
// env (.env, jangan di-commit):
//   R2_ACCOUNT, R2_BUCKET (default tdrama1)
//   R2: R2_TOKEN (dipakai hanya untuk MEMBACA)  ATAU  MIG_R2_ACCESS_KEY_ID + MIG_R2_SECRET_ACCESS_KEY (kunci khusus Object Read)
//   B2_KEY_ID, B2_APP_KEY (Application Key Read+Write untuk bucket tujuan), B2_BUCKET (nama bucket tujuan),
//   B2_ENDPOINT (default https://s3.us-west-004.backblazeb2.com)
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const env = process.env;
const args = process.argv.slice(2);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const doRun = args.includes('--run'), onlyVerify = args.includes('--verify'), overwrite = args.includes('--overwrite');
const prefix = opt('prefix', ''), conc = +opt('c', 8);
const R2_BUCKET = env.R2_BUCKET || 'tdrama1', B2_BUCKET = env.B2_BUCKET;
const dbOnly = args.includes('--db');
const API = (env.API_URL || '').replace(/\/$/, '');
const OLD_BASE = (env.OLD_PUBLIC_URL || env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const NEW_BASE = (env.NEW_PUBLIC_URL || '').replace(/\/$/, '');
const B2_ENDPOINT = env.B2_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com';
for (const k of ['R2_ACCOUNT', 'B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET']) if (!env[k]) throw new Error(`set ${k} di .env dulu`);

// ---- R2 (sumber, hanya dibaca). Kunci S3 dari token: key id = id token, secret = sha256(token)
let r2Key = env.MIG_R2_ACCESS_KEY_ID, r2Secret = env.MIG_R2_SECRET_ACCESS_KEY;
if (!r2Key) {
  if (!env.R2_TOKEN) throw new Error('set R2_TOKEN atau MIG_R2_ACCESS_KEY_ID + MIG_R2_SECRET_ACCESS_KEY');
  r2Secret = createHash('sha256').update(env.R2_TOKEN).digest('hex');
  r2Key = env.R2_ACCESS_KEY_ID; // id token (bukan rahasia). Kalau diisi di .env, tidak perlu memanggil API Cloudflare sama sekali
  for (let t = 1; !r2Key; t++) {
    try {
      const v = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.R2_ACCOUNT}/tokens/verify`, {
        headers: { authorization: `Bearer ${env.R2_TOKEN}` }, signal: AbortSignal.timeout(15000) })).json();
      if (!v.success) throw new Error('token R2 tidak valid');
      r2Key = v.result.id;
    } catch (e) {
      if (t >= 5) throw new Error(`verifikasi token R2 gagal: ${e.cause?.message || e.message} (isi R2_ACCESS_KEY_ID di .env untuk melewati langkah ini)`);
      await new Promise(r => setTimeout(r, 2000 * t));
    }
  }
}
// B2 menolak checksum default SDK baru (seperti R2), jadi hanya hitung bila diwajibkan
// + timeout: koneksi yang macet gagal dan dicoba ulang, bukan menggantung selamanya
const common = { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  requestHandler: { connectionTimeout: 15000, requestTimeout: 120000 } };
const r2 = new S3Client({ ...common, region: 'auto', endpoint: `https://${env.R2_ACCOUNT}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: r2Key, secretAccessKey: r2Secret } });
const b2 = new S3Client({ ...common, region: B2_ENDPOINT.match(/s3\.([^.]+)\./)?.[1] || 'us-west-004', endpoint: B2_ENDPOINT,
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const retry = async (fn, label, tries = 4) => {
  for (let t = 1; ; t++) {
    try { return await fn(); }
    catch (e) { if (e.fatal || t >= tries) throw new Error(`${label}: ${e.message}`); await sleep(1500 * t); }
  }
};
// API PHP (sama seperti scrape.mjs): GET kalau tanpa body, POST JSON kalau ada body. 4xx = salah data, jangan diulang.
const api = (path, body) => retry(async () => {
  const r = await fetch(`${API}/${path}`, { ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`API ${r.status}: ${j?.error ?? 'respons bukan JSON'}`), { fatal: r.status < 500 });
  return j;
}, path.split('?')[0]);
const gb = n => (n / 2 ** 30).toFixed(2) + ' GB';
const clean = s => (s || '').replace(/"/g, '');

async function listAll(client, Bucket, Prefix) {
  const out = new Map(); let ContinuationToken;
  do {
    const r = await retry(() => client.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken })), `list ${Bucket}`);
    for (const o of r.Contents || []) out.set(o.Key, { size: o.Size, etag: clean(o.ETag) });
    process.stdout.write('.'); // satu titik per halaman (1000 object), tanda listing masih jalan
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}
// sama = ukuran sama, dan ETag (MD5) sama bila keduanya bukan multipart (ETag multipart mengandung "-")
const same = (a, b) => a.size === b.size && (a.etag.includes('-') || b.etag.includes('-') || a.etag === b.etag);
const byFolder = (keys, map) => {
  const m = {};
  for (const k of keys) { const f = k.split('/')[0] + (k.includes('/') ? '/' : ''); (m[f] ??= { n: 0, size: 0 }); m[f].n++; m[f].size += map.get(k).size; }
  return Object.entries(m).map(([f, v]) => `${f} ${v.n} object (${gb(v.size)})`).join(' | ');
};

console.log(`R2 ${R2_BUCKET} -> B2 ${B2_BUCKET}${prefix ? ` (prefix ${prefix})` : ''} | mode: ${onlyVerify ? 'VERIFY' : doRun ? 'RUN' : 'DRY-RUN'}`);
process.stdout.write('membaca daftar object R2 ');
const src = await listAll(r2, R2_BUCKET, prefix);
process.stdout.write(' selesai\nmembaca daftar object B2 ');
const dst = await listAll(b2, B2_BUCKET, prefix);
const srcSize = [...src.values()].reduce((a, o) => a + o.size, 0);
console.log(`sumber R2: ${src.size} object, ${gb(srcSize)} | B2 saat ini${prefix ? ' (prefix itu)' : ''}: ${dst.size} object`);

// folder lama di B2 (mis. Tdrama/) tidak boleh tersentuh: laporkan, dan tandai kalau ada key sumber yang sama persis
const old = await listAll(b2, B2_BUCKET, 'Tdrama/');
const srcInTdrama = [...src.keys()].filter(k => k.startsWith('Tdrama/'));
console.log(`folder lama di B2 "Tdrama/": ${old.size} object (tidak disentuh). Key sumber berawalan "Tdrama/": ${srcInTdrama.length}`);

function compare() {
  const todo = [], skip = [], conflict = [];
  for (const [k, s] of src) {
    const d = dst.get(k);
    if (!d) todo.push(k); else if (same(s, d)) skip.push(k); else conflict.push(k);
  }
  return { todo, skip, conflict };
}

function report({ todo, skip, conflict }) {
  const todoSize = todo.reduce((a, k) => a + src.get(k).size, 0);
  console.log(`\nrencana: salin ${todo.length} object (${gb(todoSize)}) | sudah sama, dilewati ${skip.length} | BENTROK (ada di B2 tapi beda) ${conflict.length}`);
  if (todo.length) console.log('  yang akan disalin:', byFolder(todo, src));
  if (conflict.length) {
    console.log(`  bentrok (${overwrite ? 'akan ditimpa karena --overwrite' : 'dilewati, pakai --overwrite untuk menimpa'}), contoh:`);
    for (const k of conflict.slice(0, 20)) console.log(`    ${k}  R2=${src.get(k).size}B  B2=${dst.get(k).size}B`);
  }
  if (srcInTdrama.length) console.log(`  PERHATIAN: ${srcInTdrama.length} key sumber berawalan "Tdrama/", cek bentrok dengan folder lama.`);
  return todoSize;
}

// ponytail: seluruh object dibaca ke memori (cukup untuk video <~400 MB); object lebih besar dilaporkan gagal, perlu multipart
async function copyOne(key, s) {
  if (s.size > 400 * 2 ** 20) throw new Error('terlalu besar untuk mode memori (>400 MB)');
  const g = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const buf = Buffer.from(await g.Body.transformToByteArray());
  if (buf.length !== s.size) throw new Error(`ukuran unduhan ${buf.length} != ${s.size}`);
  const md5 = createHash('md5').update(buf).digest('hex');
  if (!s.etag.includes('-') && md5 !== s.etag) throw new Error('MD5 unduhan tidak cocok dengan ETag R2');
  const p = await b2.send(new PutObjectCommand({ Bucket: B2_BUCKET, Key: key, Body: buf, ContentType: g.ContentType,
    CacheControl: g.CacheControl, ContentDisposition: g.ContentDisposition, Metadata: g.Metadata }));
  const got = clean(p.ETag);
  if (got && got !== md5) throw new Error(`ETag B2 ${got} != MD5 ${md5}`);
}

async function verify() {
  const dst2 = await listAll(b2, B2_BUCKET, prefix);
  const missing = [], diff = [];
  for (const [k, s] of src) { const d = dst2.get(k); if (!d) missing.push(k); else if (!same(s, d)) diff.push(k); }
  console.log(`\nVERIFIKASI: ${src.size - missing.length - diff.length} dari ${src.size} object cocok | hilang di B2 ${missing.length} | beda ${diff.length}`);
  for (const k of missing.slice(0, 20)) console.log('  hilang:', k);
  for (const k of diff.slice(0, 20)) console.log(`  beda: ${k}  R2=${src.get(k).size}B/${src.get(k).etag}  B2=${dst2.get(k).size}B/${dst2.get(k).etag}`);
  if (!missing.length && !diff.length) console.log('  OK: semua object cocok (ukuran + ETag). Tetap cek manual beberapa file acak dari B2 sebelum menghapus apa pun di R2.');
  return !missing.length && !diff.length;
}

// Ubah database pusat lewat API: link yang menunjuk ke URL lama (R2) diganti ke URL baru (B2), hanya untuk object yang sudah ada di B2.
// Yang diubah: series.thumbnail_url, series.meta_url, episodes.url (status ok). Kolom lain, termasuk status, tidak berubah.
async function updateDb(apply) {
  if (!API || !OLD_BASE || !NEW_BASE) throw new Error('set API_URL, R2_PUBLIC_URL (URL lama), dan NEW_PUBLIC_URL (URL baru di B2) di .env');
  if (NEW_BASE === OLD_BASE) { console.log('\nDB: URL lama dan baru sama, tidak ada yang perlu diubah.'); return; }
  console.log(`\nDB (${apply ? 'UBAH' : 'rencana saja'}): ${OLD_BASE} -> ${NEW_BASE}`);
  const inB2 = await listAll(b2, B2_BUCKET, '');
  const rewrite = u => { // null = bukan link lama, atau objeknya belum ada di B2 (dibiarkan)
    if (!u || !u.startsWith(OLD_BASE + '/')) return null;
    return inB2.has(decodeURIComponent(u.slice(OLD_BASE.length + 1))) ? NEW_BASE + u.slice(OLD_BASE.length) : null;
  };
  const pool = async (items, fn) => { let i = 0; await Promise.all(Array.from({ length: 4 }, async () => { while (i < items.length) await fn(items[i++]); })); };

  const series = new Map();
  for (let off = 0; ; off += 200) { const page = await api(`series.php?limit=200&offset=${off}`); page.forEach(s => series.set(s.id, s)); if (page.length < 200) break; }
  const sUp = [];
  for (const s of series.values()) {
    const patch = {}, t = rewrite(s.thumbnail_url), m = rewrite(s.meta_url);
    if (t) patch.thumbnail_url = t;
    if (m) patch.meta_url = m;
    if (t || m) sUp.push({ id: s.id, title: s.title, folder: s.folder, ...patch }); // id+title+folder wajib di API; nilainya tetap sama
  }
  const state = await api('state.php');
  const eUp = []; let left = 0;
  await pool(state.series.filter(s => s.ok > 0), async s => {
    for (const e of await api(`episodes.php?series_id=${s.id}`)) {
      if (e.status !== 'ok') continue;
      const u = rewrite(e.url);
      if (u) eUp.push({ series_id: e.series_id, episode_number: e.episode_number, status: e.status, url: u }); else left++;
    }
  });
  console.log(`  series diubah: ${sUp.length}/${series.size} | episode diubah: ${eUp.length} | episode ok dibiarkan (belum ada di B2 / bukan link lama): ${left}`);
  for (const x of eUp.slice(0, 2)) console.log(`    contoh: ${x.series_id} ep${x.episode_number} -> ${x.url}`);
  if (!apply) { console.log('  (belum ada yang ditulis. Jalankan dengan --db --run untuk mengubah database lewat API.)'); return; }
  await pool(sUp, s => api('series.php', s));
  for (let i = 0; i < eUp.length; i += 200) await api('episodes.php', eUp.slice(i, i + 200)); // episodes.php menerima array
  console.log(`  SELESAI: ${sUp.length} series dan ${eUp.length} episode di database pusat sekarang menunjuk ke ${NEW_BASE}`);
}

if (onlyVerify) process.exit((await verify()) ? 0 : 1);
if (dbOnly) { await updateDb(doRun); process.exit(0); }

const plan = compare();
report(plan);
if (!doRun) { console.log('\n(dry-run: tidak ada yang disalin. Jalankan dengan --run untuk menyalin.)'); process.exit(0); }

const todo = [...plan.todo, ...(overwrite ? plan.conflict : [])];
let next = 0, done = 0, bytes = 0;
const failed = [], t0 = Date.now();
const progress = () => {
  const sec = (Date.now() - t0) / 1000;
  console.log(`  ${done + failed.length}/${todo.length} | ok ${done} gagal ${failed.length} | ${gb(bytes)} | ${(bytes / 2 ** 20 / sec).toFixed(1)} MB/s`);
};
console.log(`\nmulai menyalin ${todo.length} object dengan ${conc} pekerja (progres tiap 10 detik)...`);
await fs.writeFile('migrate-failed.txt', '');
const tick = setInterval(progress, 10000);
let streak = 0, stopped = false; // gagal beruntun: kalau banyak, hampir pasti masalah akun/kuota/jaringan, bukan file tertentu
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < todo.length) {
    const key = todo[next++];
    try { await retry(() => copyOne(key, src.get(key)), key, 3); done++; bytes += src.get(key).size; streak = 0; }
    catch (e) {
      failed.push(`${key}\t${e.message}`); streak++;
      await fs.appendFile('migrate-failed.txt', `${key}\t${e.message}\n`);
      if (failed.length <= 5) console.log(`  GAGAL ${key}: ${e.message}`);
      if (streak >= 25) {
        next = todo.length; // hentikan semua pekerja
        if (!stopped) { stopped = true; console.log(`\nBERHENTI: ${streak} gagal beruntun. Kemungkinan masalah akun/kuota/izin B2, key, atau jaringan, bukan file tertentu.\n  Pesan terakhir: ${e.message}`); }
      }
    }
  }
}));
clearInterval(tick);
progress();
if (failed.length) {
  await fs.writeFile('migrate-failed.txt', failed.join('\n') + '\n');
  console.log(`\n${failed.length} object gagal, daftar di migrate-failed.txt. Jalankan ulang --run untuk mencoba lagi (yang sudah sama dilewati).`);
}
const ok = await verify();
if (ok && !failed.length) {
  if (NEW_BASE) await updateDb(true).catch(e => console.log('\nDB: gagal diubah:', e.message, '(jalankan nanti: --db --run)'));
  else console.log('\nDB: NEW_PUBLIC_URL belum diisi, link di database pusat belum diubah (isi di .env lalu jalankan --db --run).');
}
console.log(ok && !failed.length
  ? '\nSELESAI: semua cocok. Tidak ada yang dihapus di R2. Setelah cek manual, nonaktifkan Application Key B2 read-write ini.'
  : '\nBELUM TUNTAS: perbaiki yang gagal (jalankan ulang --run) sebelum menganggap migrasi selesai.');
process.exit(ok && !failed.length ? 0 : 1);
