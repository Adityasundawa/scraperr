// node --env-file=.env main.mjs <provider> [--max=N drama] [--series=bookId] [--c=N paralel] [--delay=ms]
//   Satu alur per drama: scrape (narto-drama.com) -> upload (video+poster ke B2) -> simpan ke DB (dewadrama2.series/episodes),
//   langsung lanjut drama berikutnya. Tidak ada file JSON perantara.
// Sumber: narto-drama.com, publik, tidak perlu login.
//   /home/providers/sections (listing per tab, paginasi) -> /search/import (resolve slug)
//   -> /detail/watch/{slug}/1 (episodeItemsRaw = play_url m3u8 semua episode).
// Tujuan: tabel `series`/`episodes` SAMA dengan punya scrape.mjs/schema.sql. Aman diulang (yang sudah ok/cover dilewati).
// env: B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT (default https://s3.us-west-004.backblazeb2.com), NEW_PUBLIC_URL
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import mysql from 'mysql2/promise';
import { spawn } from 'node:child_process';

const NARTO = 'https://narto-drama.com';
const env = process.env;
const provider = process.argv[2];
if (!provider || provider.startsWith('--')) throw new Error('kasih nama provider, contoh: node --env-file=.env main.mjs anyreel');
const args = process.argv.slice(3);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const maxDramas = +opt('max', Infinity);
const onlySeries = opt('series', null);
const conc = +opt('c', 3);
const listDelay = +opt('delay', 700);
const maxPages = +opt('max-pages', 40); // sebagian tab (mis. "feed-stream" bibishort) infinite scroll, tak pernah balik array kosong
for (const k of ['B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET']) if (!env[k]) throw new Error(`set ${k} di .env dulu`);
const B2_ENDPOINT = env.B2_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com';
const B2_BUCKET = env.B2_BUCKET;
const PUBLIC_BASE = (env.NEW_PUBLIC_URL || `${B2_ENDPOINT}/${B2_BUCKET}`).replace(/\/$/, '');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const retry = async (fn, label) => {
  for (let t = 1; ; t++) {
    try { return await fn(); }
    catch (e) { if (t === 4) throw new Error(`${label}: ${e.message}`); await sleep(1500 * t); }
  }
};
const clean = s => (s || '').replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, ' ').trim();
const noQuery = u => u?.split('?')[0];

// ---- B2 (upload) + DB (dewadrama2, tabel sama persis dengan scrape.mjs/schema.sql)
const b2 = new S3Client({ region: B2_ENDPOINT.match(/s3\.([^.]+)\./)?.[1] || 'us-west-004', endpoint: B2_ENDPOINT,
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY } });
const urlOf = key => `${PUBLIC_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`;
const put = (Key, Body, ContentType) =>
  retry(() => b2.send(new PutObjectCommand({ Bucket: B2_BUCKET, Key, Body, ContentType })), Key);
// cek B2 langsung (bukan cuma status di DB): kalau object sudah ada di bucket, pakai linknya, jangan download+upload ulang
const sizeInB2 = Key => b2.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key })).then(r => r.ContentLength, () => null);
const grab = url => retry(async () => {
  const r = await fetch(url, { headers: { referer: NARTO + '/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}, noQuery(url));
// HLS (m3u8) -> mp4 lewat ffmpeg, di-stream LANGSUNG ke B2 (stdout ffmpeg -> multipart upload), tanpa singgah di disk.
// frag_keyframe+empty_moov: mp4 "fragmented" supaya moov atom tidak perlu ditulis belakangan (butuh seek, tak bisa di pipe).
// aac_adtstoasc: wajib, tanpa ini muxer mp4 menolak paket audio ADTS dari sumber HLS ("Operation not permitted").
function streamToB2(url, Key) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-user_agent', 'Mozilla/5.0', '-headers', `Referer: ${NARTO}/\r\n`,
      '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', size = 0;
    ff.stderr.on('data', d => { err += d; });
    ff.stdout.on('data', d => { size += d.length; });
    const upload = new Upload({ client: b2, params: { Bucket: B2_BUCKET, Key, Body: ff.stdout, ContentType: 'video/mp4' } });
    let ffDone = false, ffCode = null;
    ff.on('close', code => { ffDone = true; ffCode = code; });
    upload.done()
      .then(() => {
        if (ffDone && ffCode !== 0) return reject(new Error(`ffmpeg exit ${ffCode}: ${err.slice(-300)}`));
        resolve(size);
      })
      .catch(e => reject(new Error(`upload: ${e.message} | ffmpeg: ${err.slice(-300)}`)));
  });
}

const { DB_HOST = '127.0.0.1', DB_PORT = 3306, DB_USER = 'root', DB_PASS = '' } = env;
const db = await mysql.createConnection({ host: DB_HOST, port: +DB_PORT, user: DB_USER, password: DB_PASS, database: 'dewadrama2' });
await db.query(`CREATE TABLE IF NOT EXISTS series (
  id CHAR(36) PRIMARY KEY, title VARCHAR(255) NOT NULL, folder VARCHAR(255) NOT NULL, description TEXT,
  country VARCHAR(32), status VARCHAR(32), free_episode_limit INT, rating_average DECIMAL(4,2), rating_count INT,
  view_count BIGINT, featured_order DOUBLE, total_episodes INT, cover_key VARCHAR(512), thumbnail_url VARCHAR(1024),
  meta_url VARCHAR(1024), source_created_at DATETIME, source_updated_at DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_folder (folder), KEY idx_title (title)
) CHARACTER SET utf8mb4`);
await db.query(`CREATE TABLE IF NOT EXISTS episodes (
  series_id CHAR(36) NOT NULL, episode_number INT NOT NULL, source_episode_id CHAR(36), source_file VARCHAR(128),
  r2_key VARCHAR(600), url VARCHAR(1024), size_bytes BIGINT, duration DOUBLE, status ENUM('ok','locked','error') NOT NULL,
  error TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (series_id, episode_number), KEY idx_status (status),
  FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4`);
// country/status/rating/view_count tidak tersedia di narto-drama.com (sudah dicek, tidak ada di listing maupun halaman detail)
for (const col of ['source_provider VARCHAR(32)', 'category VARCHAR(128)', 'tags JSON']) {
  try { await db.query(`ALTER TABLE series ADD COLUMN ${col}`); }
  catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
}
const [existingSeries] = await db.query('SELECT id, folder, cover_key FROM series');
const byId = new Map(existingSeries.map(s => [s.id, s]));
const folders = new Set(existingSeries.map(s => s.folder));

async function getJson(url) {
  const r = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- 1. listing: kumpulkan semua drama provider ini lewat semua tab, paginasi sampai kosong (ringan, cuma metadata)
const first = await getJson(`${NARTO}/home/providers/sections?provider=${encodeURIComponent(provider)}&lang=id-ID&target_lang=id-ID`);
if (!first.ok) throw new Error('provider tidak dikenal atau gagal load: ' + provider);
const tabs = first.sections.map(s => s.tab_key);

const dramas = new Map(); // book_id -> metadata listing
for (const tab of tabs) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${NARTO}/home/providers/sections?provider=${encodeURIComponent(provider)}&lang=id-ID&target_lang=id-ID`
      + `&only_tab=${tab}&tab_pages[${tab}]=${page}`;
    const j = await getJson(url);
    const items = j.sections?.[0]?.items || [];
    if (!items.length) break;
    const allSeen = items.every(it => dramas.has(it.book_id)); // tab sudah muter balik ke item lama -> berhenti
    for (const it of items) dramas.set(it.book_id, {
      title: it.title, watch_url: it.watch_url, description: it.description || null, poster_url: it.poster_url || null,
      category: it.category_name || null, tags: it.tag_names || [],
    });
    if (allSeen) break;
    if (page === maxPages) console.log(`  tab "${tab}": berhenti di ${maxPages} halaman (kemungkinan feed infinite-scroll, bukan katalog tetap). Naikkan dengan --max-pages=N kalau mau lebih`);
    await sleep(listDelay);
  }
}
let list = [...dramas.entries()];
if (onlySeries) list = list.filter(([id]) => id === onlySeries);
list = list.slice(0, maxDramas);
console.log(`${dramas.size} drama ditemukan untuk provider "${provider}", akan diproses: ${list.length}`);

// ---- 2. per drama: scrape episode links -> upload (poster + video) -> simpan ke DB, lalu lanjut drama berikutnya
let i = 0, totalOk = 0, totalLocked = 0, totalBad = 0;
for (const [id, d] of list) {
  i++;
  try {
    // scrape: resolve slug lewat /search/import, lalu ambil episodeItemsRaw
    const imp = await fetch(d.watch_url, { redirect: 'manual' });
    const loc = imp.headers.get('location');
    if (!loc) throw new Error('tidak ada redirect dari /search/import');
    const locUrl = new URL(loc, NARTO);
    const slug = locUrl.pathname.startsWith('/detail/watch/') ? locUrl.pathname.split('/').pop() : null;
    const epUrl = slug ? `${NARTO}/detail/watch/${slug}/1?lang=id-ID` : `${NARTO}${locUrl.pathname}${locUrl.search}`;
    const epPage = await fetch(epUrl);
    const html = await epPage.text();
    const m = html.match(/const episodeItemsRaw = (\[.*?\]);/s);
    const episodes = (m ? JSON.parse(m[1]) : []).map(e => ({ number: e.number, video_url: e.play_url || e.direct_play_url || null }));

    // upload + simpan ke DB
    const existing = byId.get(id);
    let folder = existing?.folder;
    if (!folder) {
      folder = clean(d.title) || id;
      if (folders.has(folder)) folder += ` [${id.slice(0, 8)}]`;
      folders.add(folder);
    }
    const base = `series/${folder}`;

    let coverKey = existing?.cover_key || null;
    if (!coverKey && d.poster_url) {
      const posterUrl = /^https?:\/\//.test(d.poster_url) ? d.poster_url : NARTO + d.poster_url;
      const ext = noQuery(posterUrl).match(/\.\w+$/)?.[0] || '.jpg';
      coverKey = `${base}/cover${ext}`;
      try {
        if (!(await sizeInB2(coverKey))) await put(coverKey, await grab(posterUrl), 'image/jpeg'); // sudah ada di B2 -> lewati
      } catch (err) { console.error(`  GAGAL poster ${d.title}: ${err.message}`); coverKey = null; }
    }

    await db.query(`INSERT INTO series (id, title, folder, description, total_episodes, cover_key, thumbnail_url, source_provider, category, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE title=VALUES(title), description=VALUES(description), total_episodes=VALUES(total_episodes),
        cover_key=COALESCE(VALUES(cover_key), cover_key), thumbnail_url=COALESCE(VALUES(thumbnail_url), thumbnail_url),
        source_provider=VALUES(source_provider), category=VALUES(category), tags=VALUES(tags)`,
      [id, d.title, folder, d.description, episodes.length, coverKey, coverKey ? urlOf(coverKey) : null,
        provider, d.category, JSON.stringify(d.tags)]);

    const [doneRows] = await db.query("SELECT episode_number FROM episodes WHERE series_id = ? AND status = 'ok'", [id]);
    const done = new Set(doneRows.map(r => r.episode_number));

    let ok = 0, locked = 0, bad = 0, next = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < episodes.length) {
        const e = episodes[next++];
        const n = e.number;
        if (done.has(n)) { console.log(`[SKIP] ${d.title} - Episode ${n} (sudah ok di DB)`); ok++; continue; }
        if (!e.video_url) {
          await db.query(`INSERT INTO episodes (series_id, episode_number, status) VALUES (?, ?, 'locked')
            ON DUPLICATE KEY UPDATE status = 'locked'`, [id, n]);
          locked++; continue;
        }
        const tag = `ep${String(n).padStart(3, '0')}`, key = `${base}/${tag}.mp4`;
        console.log(`[SCRAPT] ${d.title} - Episode ${n}`);
        try {
          const sourceFile = noQuery(e.video_url).split('/').pop();
          let size = await sizeInB2(key); // sudah ada di B2 (mis. dari run sebelumnya) -> jangan download+upload ulang
          if (size) {
            console.log(`[SKIP] ${d.title} - Episode ${n} (sudah ada di B2)`);
          } else {
            size = await streamToB2(e.video_url, key); // ffmpeg -> stdout -> langsung ke B2, tanpa file sementara
            console.log(`[UPLOAD] ${d.title} - Episode ${n} (${(size / 2 ** 20).toFixed(1)} MB)`);
          }
          await db.query(`INSERT INTO episodes (series_id, episode_number, source_file, r2_key, url, size_bytes, status, error)
            VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL)
            ON DUPLICATE KEY UPDATE source_file=VALUES(source_file), r2_key=VALUES(r2_key), url=VALUES(url),
              size_bytes=VALUES(size_bytes), status='ok', error=NULL`,
            [id, n, sourceFile, key, urlOf(key), size]);
          ok++;
        } catch (err) {
          await db.query(`INSERT INTO episodes (series_id, episode_number, status, error) VALUES (?, ?, 'error', ?)
            ON DUPLICATE KEY UPDATE status='error', error=VALUES(error)`, [id, n, err.message]);
          bad++;
        }
      }
    }));
    totalOk += ok; totalLocked += locked; totalBad += bad;
    console.log(`[${i}/${list.length}] ${d.title}: ok ${ok}, terkunci ${locked}, gagal ${bad} / ${episodes.length} -> ${base}/`);
  } catch (err) {
    console.error(`[${i}/${list.length}] GAGAL drama ${d.title} (${id}): ${err.message}`);
  }
}

console.log(`SELESAI: ${list.length} drama diproses | episode: ok ${totalOk}, terkunci ${totalLocked}, gagal ${totalBad}`);
await db.end();
