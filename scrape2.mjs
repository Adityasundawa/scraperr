// node scrape2.mjs --init                       -> cuma buat database dewadrama2 + tabel, lalu selesai
// node scrape2.mjs --meta                       -> hanya metadata semua drama (deskripsi, rating, cover, ...), tanpa episode, tanpa login
// node scrape2.mjs <seriesId...> | --all  [--max=N drama] [--batch=N drama/request] [--c=N paralel] [--delay=ms] [--page] [--refresh]
//   default = mode "direct" (cepat: panggil GraphQL langsung pakai header login app); --page = buka halaman satu-satu (lambat)
// Hanya mengumpulkan link video + metadata ke MySQL lokal (dewadrama2). Tidak mengunduh / upload apa pun.
// video_url bertanda tangan & kedaluwarsa (lihat expires_at); video_path = bagian tetapnya tanpa query.
import { chromium } from 'playwright';
import mysql from 'mysql2/promise';
import readline from 'node:readline/promises';

const BASE = 'https://tadrama.flicka.id';
const { DB_HOST = '127.0.0.1', DB_PORT = 3306, DB_USER = 'root', DB_PASS = '' } = process.env;
const DB_NAME = 'dewadrama2';
const args = process.argv.slice(2);
const opt = (k, d = Infinity) => +(args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] || d);
const [maxSeries, cArg, dArg] = [opt('max'), opt('c', 0), opt('delay', -1)]; // c / delay (ms) default tergantung mode
const pageOnly = args.includes('--page');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let B = opt('batch', 10); // drama per request di mode direct; otomatis dikecilkan kalau server menolak
let hdrs; // header request GraphQL milik app (termasuk autentikasi), ditangkap dari browser
let sentinel; // id drama yang terbuka penuh di akun ini; dipakai untuk memastikan login masih valid
const refresh = args.includes('--refresh');
let ids = args.filter(a => !a.startsWith('--'));

// ---- database: bikin kalau belum ada
const conn = { host: DB_HOST, port: +DB_PORT, user: DB_USER, password: DB_PASS };
const root = await mysql.createConnection(conn);
await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await root.end();
const db = await mysql.createConnection({ ...conn, database: DB_NAME });
await db.query(`CREATE TABLE IF NOT EXISTS series (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  country VARCHAR(32),
  status VARCHAR(32),
  free_episode_limit INT,
  rating_average DECIMAL(4,2),
  rating_count INT,
  view_count BIGINT,
  total_episodes INT,
  cover_url VARCHAR(1024),
  source_created_at DATETIME,
  source_updated_at DATETIME,
  scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_title (title)
) CHARACTER SET utf8mb4`);
await db.query(`CREATE TABLE IF NOT EXISTS episodes (
  series_id CHAR(36) NOT NULL,
  episode_number INT NOT NULL,
  source_episode_id CHAR(36),
  video_url VARCHAR(1024),
  video_path VARCHAR(512),
  expires_at DATETIME,
  duration DOUBLE,
  is_locked TINYINT(1) NOT NULL DEFAULT 0,
  scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, episode_number),
  KEY idx_path (video_path),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4`);
await db.query(`CREATE TABLE IF NOT EXISTS subtitles (
  series_id CHAR(36) NOT NULL,
  episode_number INT NOT NULL,
  language VARCHAR(16) NOT NULL,
  format VARCHAR(16),
  url VARCHAR(1024),
  PRIMARY KEY (series_id, episode_number, language),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4`);
if (args.includes('--init')) { await db.end(); console.log(`database ${DB_NAME} siap`); process.exit(0); }
const metaOnly = args.includes('--meta');
if (!ids.length && !args.includes('--all') && !metaOnly) throw new Error('kasih series id, --all, atau --meta');

// ---- browser (profil login yang sama dengan scrape.mjs)
const ctx = await chromium.launchPersistentContext('.profile', { channel: 'chrome', headless: false, viewport: null });
const first = ctx.pages()[0] ?? await ctx.newPage();
await first.goto(BASE);
if (!metaOnly) { // --meta tidak butuh login (daftar katalog publik)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Login (akun premium) kalau belum, lalu tekan ENTER... ');
  rl.close();
}
await ctx.route('**/*', r => ['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()); // gambar/video tidak perlu
first.on('request', r => {
  if (r.url().endsWith('/graphql') && r.method() === 'POST')
    hdrs = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => !['content-length', 'host', 'cookie'].includes(k)));
});

if (metaOnly) { // hanya metadata series, tanpa episode: listSeries 100 drama per request (~55 request untuk seluruh katalog)
  const rows = await first.evaluate(async () => {
    const q = `query($p:PaginationInput){listSeries(pagination:$p){edges{node{id title description coverImageUrl freeEpisodeLimit status country
      createdAt episodeCount ratingAverage ratingCount platformViewCount}}pageInfo{hasNextPage endCursor}}}`;
    const out = []; let after = null;
    do {
      let r;
      for (let t = 0; t < 5; t++) { // kena throttle: tunggu 60 detik lalu coba lagi
        r = await (await fetch('/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: q, variables: { p: { first: 100, ...(after && { after }) } } }) })).json();
        if (!r.errors) break;
        await new Promise(res => setTimeout(res, 60000));
      }
      if (r.errors) throw new Error(r.errors[0].message);
      const l = r.data.listSeries; out.push(...l.edges.map(e => e.node));
      after = l.pageInfo.hasNextPage ? l.pageInfo.endCursor : null;
    } while (after);
    return out;
  });
  const cols = ['id', 'title', 'description', 'country', 'status', 'free_episode_limit', 'rating_average', 'rating_count', 'view_count', 'total_episodes', 'cover_url', 'source_created_at'];
  for (let i = 0; i < rows.length; i += 500) {
    await db.query(`INSERT INTO series (${cols.join(', ')}) VALUES ? ON DUPLICATE KEY UPDATE ${cols.slice(1).map(c => `${c} = VALUES(${c})`).join(', ')}`,
      [rows.slice(i, i + 500).map(s => [s.id, s.title, s.description, s.country, s.status, s.freeEpisodeLimit, s.ratingAverage, s.ratingCount,
        s.platformViewCount, s.episodeCount, s.coverImageUrl, s.createdAt && new Date(s.createdAt)])]);
  }
  const [[t]] = await db.query('SELECT COUNT(*) n, SUM(description IS NOT NULL AND description <> \'\') desc_ok, SUM(cover_url IS NOT NULL) covers FROM series');
  console.log(`META selesai: ${rows.length} drama dari katalog. Di ${DB_NAME}.series sekarang: ${t.n} drama, ${t.desc_ok} punya deskripsi, ${t.covers} punya cover. Episode tidak disentuh.`);
  await db.end(); await ctx.close(); process.exit(0);
}

if (args.includes('--all')) { // daftar semua drama (query publik, paginasi cursor)
  ids = await first.evaluate(async () => {
    const q = `query($p:PaginationInput){listSeries(pagination:$p){edges{node{id}}pageInfo{hasNextPage endCursor}}}`;
    const out = []; let after = null;
    do {
      const r = await (await fetch('/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, variables: { p: { first: 100, ...(after && { after }) } } }) })).json();
      const l = r.data.listSeries; out.push(...l.edges.map(e => e.node.id));
      after = l.pageInfo.hasNextPage ? l.pageInfo.endCursor : null;
    } while (after);
    return out;
  });
}
const have = new Set((await db.query('SELECT id FROM series'))[0].map(r => r.id));
const todo = ids.filter(i => refresh || !have.has(i)).slice(0, maxSeries);
console.log(`${ids.length} drama di daftar, ${ids.length - ids.filter(i => !have.has(i)).length} sudah ada di ${DB_NAME}, ${todo.length} akan di-scrape`);

async function getSeries(pg, id) { // baca respons query bawaan app (sudah bawa auth premium)
  const resp = pg.waitForResponse(async r => r.url().endsWith('/graphql') && (r.status() === 429 || (await r.json().catch(() => null))?.data?.series?.id === id), { timeout: 30000 });
  await pg.goto(`${BASE}/series/${id}`);
  const r = await resp;
  if (r.status() === 429) throw Object.assign(new Error('rate limit 429'), { rate: true });
  return (await r.json()).data.series;
}

async function directBatch(ids) { // cepat: beberapa drama dalam SATU request GraphQL (alias), tanpa render halaman
  const query = `query { ${ids.map((id, i) => `s${i}: series(id: ${JSON.stringify(id)}) { ...F }`).join(' ')} }
    fragment F on SeriesObject { id title description coverImageUrl freeEpisodeLimit status country featuredOrder createdAt updatedAt
    ratingAverage ratingCount platformViewCount episodes { id episodeNumber videoUrl duration isLocked subtitles { id language label url format isDefault } } }`;
  const r = await ctx.request.post(`${BASE}/graphql`, { headers: hdrs, data: { query } });
  if (r.status() === 429) throw Object.assign(new Error('rate limit 429'), { rate: true });
  if (!r.ok()) throw new Error('HTTP ' + r.status());
  const j = await r.json();
  if (j.errors) { // throttle datang sebagai error GraphQL (HTTP 200), bukan status 429
    const m = j.errors[0].message;
    throw Object.assign(new Error(m), { rate: /throttl|too many/i.test(m) });
  }
  return ids.map((_, i) => j.data?.[`s${i}`] ?? null);
}
const direct = id => directBatch([id]).then(r => r[0]);

async function save(s) {
  const row = { id: s.id, title: s.title, description: s.description, country: s.country, status: s.status,
    free_episode_limit: s.freeEpisodeLimit, rating_average: s.ratingAverage, rating_count: s.ratingCount,
    view_count: s.platformViewCount, total_episodes: s.episodes.length, cover_url: s.coverImageUrl,
    source_created_at: s.createdAt && new Date(s.createdAt), source_updated_at: s.updatedAt && new Date(s.updatedAt) };
  await db.query('INSERT INTO series SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
  if (!s.episodes.length) return;
  await db.query(`INSERT INTO episodes (series_id, episode_number, source_episode_id, video_url, video_path, expires_at, duration, is_locked)
    VALUES ? ON DUPLICATE KEY UPDATE source_episode_id = VALUES(source_episode_id), video_url = VALUES(video_url),
    video_path = VALUES(video_path), expires_at = VALUES(expires_at), duration = VALUES(duration), is_locked = VALUES(is_locked)`,
  [s.episodes.map(e => {
    const exp = e.videoUrl && new URL(e.videoUrl).searchParams.get('exp');
    return [s.id, e.episodeNumber, e.id, e.videoUrl ?? null, e.videoUrl?.split('?')[0] ?? null, exp ? new Date(exp * 1000) : null, e.duration ?? null, e.isLocked ? 1 : 0];
  })]);
  const subs = s.episodes.flatMap(e => (e.subtitles || []).map(x => [s.id, e.episodeNumber, x.language, x.format ?? null, x.url]));
  if (subs.length) await db.query('INSERT INTO subtitles (series_id, episode_number, language, format, url) VALUES ? ON DUPLICATE KEY UPDATE format = VALUES(format), url = VALUES(url)', [subs]);
}

// beberapa tab paralel, tiap tab mengambil drama berikutnya dari antrean
let done = 0, failed = 0, pauseUntil = 0, backoff = 60000; // kena 429: semua tab berhenti, tunggu makin lama (maks 10 menit)
// pilih mode: satu drama diambil lewat halaman (app mengirim request ber-auth -> header ditangkap), lalu hasil
// panggilan langsung dibandingkan. Kalau jumlah link video beda, tetap pakai mode halaman.
let mode = 'page';
if (!pageOnly && todo.length) {
  const probe = todo.shift();
  let sp;
  try {
    sp = await getSeries(first, probe);
    await save(sp);
    console.log(`[probe] ${sp.title}: ${sp.episodes.length} ep`);
  } catch (e) { console.warn(`probe ${probe} gagal (${e.message}), pakai mode halaman`); todo.unshift(probe); }
  if (sp && !hdrs) console.warn('header app tidak tertangkap, pakai mode halaman');
  if (sp && hdrs) {
    try {
      const links = s => s.episodes.filter(e => e.videoUrl).length;
      const sd = await direct(probe);
      if (links(sd) === links(sp)) mode = 'direct';
      else console.warn(`mode direct ditolak (${links(sd)} vs ${links(sp)} link), pakai mode halaman`);
    } catch (e) { console.warn('mode direct gagal, pakai mode halaman:', e.message); }
  }
}
if (mode === 'direct') {
  const [[r]] = await db.query('SELECT series_id FROM episodes GROUP BY series_id HAVING COUNT(*) > 5 AND SUM(is_locked) = 0 LIMIT 1');
  sentinel = r?.series_id;
  if (!sentinel) console.warn('belum ada drama yang terbuka penuh di DB: episode terkunci akan menghentikan run (tidak bisa dibedakan dari login habis)');
}
// server membatasi per DRAMA yang diambil (bukan per request), kira-kira 150 per menit. Default direct:
// 1 pekerja, jeda B*550ms per batch = ~1,7 drama/detik (~100/menit). Naikkan hati-hati (--c, --delay, --batch)
const conc = cArg || (mode === 'direct' ? 1 : 2);
const delay = dArg >= 0 ? dArg : (mode === 'direct' ? Math.round(B * 550) : 2000);
let gap = delay; // jeda antar request; naik 1,5x otomatis tiap kena throttle (maks 30 detik)
console.log(`mode ${mode}: ${conc} paralel, jeda ${delay}ms, ${todo.length} drama`);
const queue = [...todo];
const pages = mode === 'direct' ? Array(conc).fill(null)
  : [first, ...await Promise.all(Array.from({ length: Math.max(conc - 1, 0) }, () => ctx.newPage()))];
await Promise.all(pages.map(async pg => {
  while (queue.length) {
    const batch = queue.splice(0, mode === 'direct' ? B : 1);
    await sleep(Math.max(pauseUntil - Date.now(), 0) + gap);
    try {
      const got = mode === 'direct' ? await directBatch(batch) : [await getSeries(pg, batch[0])];
      if (mode === 'direct' && got.some(s => s?.episodes.some(e => e.isLocked))) {
        // ada yang terkunci: memang terkunci untuk akun ini, atau login habis? cek lewat drama sentinel (harus terbuka penuh)
        const chk = sentinel ? await direct(sentinel) : null;
        if (!chk || chk.episodes.some(e => e.isLocked)) {
          queue.length = 0;
          console.error('BERHENTI: ada episode terkunci dan drama sentinel juga terkunci -> login/token habis. Batch ini TIDAK disimpan. Jalankan ulang, atau pakai --page');
          return;
        }
      }
      for (const [i, s] of got.entries()) {
      if (!s) { failed++; console.error(`GAGAL ${batch[i]}: tidak ada di respons`); continue; }
      await save(s);
      backoff = 60000;
      const locked = s.episodes.filter(e => e.isLocked || !e.videoUrl).length;
      console.log(`[${++done}/${todo.length}] ${s.title}: ${s.episodes.length} ep, terkunci ${locked}${locked ? '  <- terkunci untuk akun ini' : ''}`);
      }
    } catch (err) {
      if (err.rate) { // rate limit: antrekan lagi, semua pekerja menunggu
        if (Date.now() >= pauseUntil) { // hanya kegagalan pertama dalam satu gelombang yang menaikkan backoff
          pauseUntil = Date.now() + backoff;
          gap = Math.min(Math.round(gap * 1.5), 30000);
          console.warn(`RATE LIMIT, semua pekerja menunggu ${backoff / 1000}s, jeda antar request jadi ${gap}ms`);
          backoff = Math.min(backoff * 2, 600000);
        }
        queue.unshift(...batch);
      } else if (batch.length > 1) { // batch ditolak server (mis. terlalu kompleks): kecilkan, coba lagi
        B = Math.max(1, B >> 1);
        console.warn(`batch ditolak (${err.message}), ukuran batch jadi ${B}`);
        queue.unshift(...batch);
      } else { failed++; console.error(`GAGAL ${batch[0]}: ${err.message}`); }
    }
  }
}));

const [[t]] = await db.query(`SELECT (SELECT COUNT(*) FROM series) s, COUNT(*) e, SUM(video_url IS NOT NULL) links, SUM(is_locked) locked FROM episodes`);
console.log(`SELESAI ${DB_NAME}: ${t.s} drama, ${t.e} episode, ${t.links} link video, ${t.locked} terkunci. Gagal di run ini: ${failed}`);
await db.end();
await ctx.close();
