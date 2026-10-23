// node scrape.mjs <seriesId...> | --all   [--max=N drama] [--n=N episode/drama] [--gb=N] [--newest]
// env: R2_ACCOUNT, R2_TOKEN, R2_PUBLIC_URL (https://pub-xxx.r2.dev), R2_BUCKET (default tdrama1),
//      API_URL (https://<server-kamu>/api) -- data ditulis lewat API PHP (folder api/), bukan langsung ke MySQL
import { chromium } from 'playwright';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';

const BASE = 'https://tadrama.flicka.id';
const { R2_ACCOUNT, R2_TOKEN, R2_BUCKET = 'tdrama1', R2_PUBLIC_URL, API_URL } = process.env;
if (!R2_ACCOUNT || !R2_TOKEN || !R2_PUBLIC_URL || !API_URL) throw new Error('set R2_ACCOUNT, R2_TOKEN, R2_PUBLIC_URL, API_URL dulu');
const PUBLIC = R2_PUBLIC_URL.replace(/\/$/, '');
const API = API_URL.replace(/\/$/, '');

const args = process.argv.slice(2);
const opt = k => +(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] || Infinity);
const [maxSeries, maxEps] = [opt('max'), opt('n')];
const capGB = isFinite(opt('gb')) ? opt('gb') : 9; // batas storage R2; free tier = 10 GB, sisakan margin
const newest = args.includes('--newest'); // urutan --all: tanggal dibuat terbaru -> terlama (default katalog = terpopuler dulu)
let ids = args.filter(a => !a.startsWith('--'));
if (!ids.length && !args.includes('--all')) throw new Error('kasih series id atau --all');

// ---- R2 (kunci S3 diturunkan dari token: key id = id token, secret = sha256(token))
const v = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${R2_ACCOUNT}/tokens/verify`, {
  headers: { authorization: `Bearer ${R2_TOKEN}` } })).json();
if (!v.success) throw new Error('token R2 tidak valid');
const s3 = new S3Client({
  region: 'auto', endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
  requestChecksumCalculation: 'WHEN_REQUIRED', // R2 menolak checksum default SDK baru
  credentials: { accessKeyId: v.result.id, secretAccessKey: createHash('sha256').update(R2_TOKEN).digest('hex') },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const noQuery = u => u?.split('?')[0];
const clean = s => s.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, ' ').trim();
const urlOf = key => `${PUBLIC}/${key.split('/').map(encodeURIComponent).join('/')}`; // link yang bisa dibuka di browser
const retry = async (fn, label) => {
  for (let t = 1; ; t++) {
    try { return await fn(); }
    catch (e) { if (e.fatal || t === 6) throw new Error(`${label}: ${e.message}`); await sleep(2000 * t); } // 503 / jaringan: coba lagi
  }
};
// API PHP: GET kalau tanpa body, POST JSON kalau ada body. 4xx = salah data, jangan diulang.
const api = (path, body) => retry(async () => {
  const r = await fetch(`${API}/${path}`, body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw Object.assign(new Error(`API ${r.status}: ${j?.error ?? 'respons bukan JSON'}`), { fatal: r.status < 500 });
  return j;
}, path.split('?')[0]);
const put = (Key, Body, ContentType) =>
  retry(() => s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key, Body, ContentType })), Key);
const sizeInR2 = Key => s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key })).then(r => r.ContentLength, () => null);
const grab = url => retry(async () => {
  const r = await fetch(url, { headers: { referer: BASE + '/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}, noQuery(url));
// upload.log: UPLOAD = baru naik (+ link), SKIP = sudah ada, DUPLIKAT = file sama dipakai ulang, BELUM = terkunci, GAGAL = gagal (+ alasan)
const log = line => { const l = `${new Date().toISOString()} ${line}`; console.log(l); return fs.appendFile('upload.log', l + '\n'); };

// progres yang sudah ada di server (resume, cek folder kembar, pemakaian storage)
const state = await api('state.php');
const known = new Map(state.series.map(s => [s.id, s]));
const folders = new Set(state.series.map(s => s.folder));
let used = state.used_bytes;
let full = false;

const ctx = await chromium.launchPersistentContext('.profile', { channel: 'chrome', headless: false, viewport: null });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(BASE);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Login (akun premium) kalau belum, lalu tekan ENTER... ');
rl.close();
let hdrs; // header request GraphQL milik app (termasuk auth), ditangkap dari browser; dipakai untuk query playback
page.on('request', r => {
  if (r.url().endsWith('/graphql') && r.method() === 'POST')
    hdrs = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => !['content-length', 'host', 'cookie'].includes(k)));
});

const complete = s => s && s.total_episodes > 0 && s.ok === s.total_episodes;
if (args.includes('--all')) { // daftar semua drama (query publik, paginasi cursor)
  const nodes = await page.evaluate(async () => {
    const q = `query($p:PaginationInput){listSeries(pagination:$p){edges{node{id createdAt}}pageInfo{hasNextPage endCursor}}}`;
    const out = []; let after = null;
    do {
      const r = await (await fetch('/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, variables: { p: { first: 100, ...(after && { after }) } } }) })).json();
      const l = r.data.listSeries; out.push(...l.edges.map(e => e.node));
      after = l.pageInfo.hasNextPage ? l.pageInfo.endCursor : null;
    } while (after);
    return out;
  });
  if (newest) nodes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  ids = nodes.map(n => n.id);
  const lengkap = ids.filter(i => complete(known.get(i))).length;
  await log(`KATALOG ${ids.length} drama: ${lengkap} sudah lengkap di server, ${ids.length - lengkap} belum`);
}

async function getSeries(id) { // baca respons query bawaan app (sudah bawa auth premium)
  const resp = page.waitForResponse(async r => r.url().endsWith('/graphql') && (await r.json().catch(() => null))?.data?.series?.id === id, { timeout: 30000 });
  await page.goto(`${BASE}/series/${id}`);
  return (await (await resp).json()).data.series;
}

// Jalur yang dipakai player app untuk memutar episode: episodePlayback (per akun). Dipakai untuk episode yang videoUrl-nya
// kosong di query series. Kalau server bilang isLocked, episode tetap terkunci: tidak ada yang dipaksa.
async function playback(seriesId, episodeIds) {
  const out = new Map();
  for (let i = 0; i < episodeIds.length; i += 3) { // server hanya menerima 1-3 episode per request
    await sleep(600); // ~100 request/menit, di bawah batas throttle
    for (let t = 0; ; t++) {
      const r = await ctx.request.post(`${BASE}/graphql`, { headers: hdrs, data: {
        query: 'query($s:ID!,$e:[ID!]!){episodePlayback(seriesId:$s,episodeIds:$e){id videoUrl isLocked}}',
        variables: { s: seriesId, e: episodeIds.slice(i, i + 3) } } });
      const j = await r.json().catch(() => null);
      const msg = j?.errors?.[0]?.message ?? (r.ok() ? '' : 'HTTP ' + r.status());
      if (!msg) { for (const p of j.data.episodePlayback) out.set(p.id, p); break; }
      if (t < 5 && (r.status() === 429 || /throttl|too many/i.test(msg))) { await sleep(60000); continue; } // kena throttle: tunggu
      throw new Error('episodePlayback: ' + msg);
    }
  }
  return out;
}

for (const id of ids.slice(0, maxSeries)) {
  try {
    const st = known.get(id);
    if (complete(st) && maxEps === Infinity) { await log(`SKIP    ${id}: lengkap ${st.ok} ep -> ${st.folder}`); continue; }

    const s = await getSeries(id);
    let folder = st?.folder;
    if (!folder) { // folder = judul; kalau judul kembar, tambah 8 char pertama ID
      folder = clean(s.title) || id;
      if (folders.has(folder)) folder += ` [${id.slice(0, 8)}]`;
      folders.add(folder);
    }
    const base = `series/${folder}`;
    const seriesRow = { id, title: s.title, folder, description: s.description, country: s.country, status: s.status,
      free_episode_limit: s.freeEpisodeLimit, rating_average: s.ratingAverage, rating_count: s.ratingCount,
      view_count: s.platformViewCount, featured_order: s.featuredOrder, total_episodes: s.episodes.length,
      meta_url: urlOf(`${base}/meta.json`), source_created_at: s.createdAt, source_updated_at: s.updatedAt };
    await api('series.php', seriesRow);

    const done = new Set((await api(`episodes.php?series_id=${id}`)).filter(e => e.status === 'ok').map(e => e.episode_number));
    const need = s.episodes.slice(0, maxEps).filter(e => !e.videoUrl && !done.has(e.episodeNumber));
    if (need.length && hdrs) { // videoUrl kosong di query series: tanya jalur playback yang dipakai player
      try {
        const pb = await playback(id, need.map(e => e.id));
        let opened = 0;
        for (const e of need) { const p = pb.get(e.id); if (p?.videoUrl && !p.isLocked) { e.videoUrl = p.videoUrl; opened++; } }
        await log(`PLAYBACK ${s.title}: ${opened} dari ${need.length} episode kosong ternyata bisa diputar akun ini`);
      } catch (err) { await log(`PLAYBACK ${s.title}: gagal (${err.message}), pakai data query series`); }
    }
    let ok = 0, locked = 0, bad = 0;
    for (const e of s.episodes.slice(0, maxEps)) {
      const n = e.episodeNumber, tag = `ep${String(n).padStart(3, '0')}`, key = `${base}/${tag}.mp4`;
      const ep = { series_id: id, episode_number: n, source_episode_id: e.id, duration: e.duration,
        source_file: e.videoUrl ? noQuery(e.videoUrl).split('/').pop() : null }; // nama file asli (hash) = identitas konten
      if (done.has(n)) { ok++; continue; }
      if (!e.videoUrl) { await api('episodes.php', { ...ep, status: 'locked' }); locked++; await log(`BELUM   ${s.title} ep${n}: terkunci (tidak ada videoUrl)`); continue; }
      try {
        let size = await sizeInR2(key), r2Key = key, url = urlOf(key); // sudah ada di R2 (mis. dari run sebelumnya)? jangan unduh ulang
        if (size) { used += size; await log(`SKIP    ${s.title} ep${n}: sudah ada di R2 -> ${url}`); }
        else {
          // file sumber yang sama sudah pernah diunggah di series/episode lain? pakai ulang, jangan simpan dua kali
          const same = await api(`episodes.php?source_file=${encodeURIComponent(ep.source_file)}&series_id=${id}&episode_number=${n}`);
          if (same) {
            [r2Key, url, size] = [same.r2_key, same.url, same.size_bytes];
            await log(`DUPLIKAT ${s.title} ep${n}: file sama sudah ada -> ${url}`);
          } else {
            if (used >= capGB * 2 ** 30) { full = true; break; } // batas free tier tercapai
            const buf = await grab(e.videoUrl);
            await put(key, buf, 'video/mp4');
            size = buf.length; used += size;
            await log(`UPLOAD  ${s.title} ep${n} -> ${url} (${(size / 1048576).toFixed(1)} MB)`);
          }
        }
        const subtitles = [];
        for (const sub of e.subtitles || []) {
          const k = `${base}/${tag}.${sub.language}.${sub.format || 'vtt'}`;
          await put(k, await grab(sub.url), 'text/plain');
          subtitles.push({ language: sub.language, r2_key: k, url: urlOf(k) });
        }
        await api('episodes.php', { ...ep, r2_key: r2Key, url, size_bytes: size, status: 'ok', error: null, subtitles });
        ok++;
      } catch (err) { await api('episodes.php', { ...ep, status: 'error', error: err.message }); bad++; await log(`GAGAL   ${s.title} ep${n}: ${err.message}`); }
    }
    if (!st?.cover_key && s.coverImageUrl) { // thumbnail
      const coverKey = `${base}/cover${noQuery(s.coverImageUrl).match(/\.\w+$/)?.[0] || '.jpg'}`;
      await put(coverKey, await grab(s.coverImageUrl), 'image/jpeg');
      await api('series.php', { ...seriesRow, cover_key: coverKey, thumbnail_url: urlOf(coverKey) });
    }
    await put(`${base}/meta.json`, JSON.stringify({ ...s, coverImageUrl: noQuery(s.coverImageUrl),
      episodes: s.episodes.map(e => ({ ...e, videoUrl: noQuery(e.videoUrl) })) }, null, 2), 'application/json');
    await log(`RINGKAS ${s.title}: ok ${ok}, terkunci ${locked}, gagal ${bad} / ${s.episodes.length} -> ${base}/`);
    if (full) { await log(`STOP    batas ${capGB} GB tercapai (free tier R2 10 GB). Naikkan dengan --gb=N kalau mau lanjut`); break; }
  } catch (err) { await log(`GAGAL   ${id}: ${err.message}`); }
}
const end = await api('state.php');
await log(`TOTAL   server: ${end.series.length} drama, ${end.totals.ok} ep ok, ${end.totals.locked} terkunci, ${end.totals.error} gagal, ${(end.used_bytes / 2 ** 30).toFixed(2)} GB`);
await ctx.close();
