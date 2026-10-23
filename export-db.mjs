// node export-db.mjs [--dry]
// Salin tabel series dari dewadrama2 ke dewa_drama (TANPA episode). Aman diulang, tidak membuat duplikat:
//  - id sudah ada di dewa_drama -> hanya metadata diperbarui (folder/cover/R2 tidak disentuh)
//  - id baru                    -> di-insert; folder = judul (kalau bentrok, + [8 char ID])
//  - judul + deskripsi + jumlah episode sama dengan series lain -> dianggap duplikat, dilewati
import mysql from 'mysql2/promise';

const { DB_HOST = '127.0.0.1', DB_PORT = 3306, DB_USER = 'root', DB_PASS = '' } = process.env;
const conn = { host: DB_HOST, port: +DB_PORT, user: DB_USER, password: DB_PASS, charset: 'utf8mb4' };
const dry = process.argv.includes('--dry');
const src = await mysql.createConnection({ ...conn, database: 'dewadrama2' });
const dst = await mysql.createConnection({ ...conn, database: 'dewa_drama' });

// kunci perbandingan tanpa beda huruf besar/kecil & aksen (sama seperti collation dewa_drama)
const norm = s => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const clean = s => s.replace(/[\\/:*?"<>|#%]/g, '').replace(/\s+/g, ' ').trim();
const sig = s => `${norm(s.title)}|${norm(s.description)}|${s.total_episodes}`;

const [rows] = await src.query('SELECT * FROM series ORDER BY source_created_at, id');
const [have] = await dst.query('SELECT id, folder, title, description, total_episodes FROM series');
const haveIds = new Set(have.map(r => r.id));
const folders = new Set(have.map(r => norm(r.folder)));
const seen = new Map(have.map(r => [sig(r), r.id]));

const update = [], insert = [], dup = [];
for (const s of rows) {
  if (haveIds.has(s.id)) { update.push(s); continue; }
  const k = sig(s);
  if (seen.has(k)) { dup.push({ title: s.title, id: s.id, sama_dengan: seen.get(k) }); continue; }
  seen.set(k, s.id);
  let folder = clean(s.title) || s.id;
  if (folders.has(norm(folder))) folder += ` [${s.id.slice(0, 8)}]`;
  if (folders.has(norm(folder))) folder += ` ${s.id}`; // sangat jarang
  folders.add(norm(folder));
  insert.push({ ...s, folder });
}
console.log(`sumber ${rows.length} series | di dewa_drama sebelumnya ${have.length} | baru ${insert.length} | metadata diperbarui ${update.length} | duplikat dilewati ${dup.length}`);
if (dup.length) console.table(dup);
if (dry) { console.log('(--dry: tidak ada yang ditulis)'); await src.end(); await dst.end(); process.exit(0); }

await dst.beginTransaction();
try {
  for (const s of insert) {
    await dst.query(`INSERT INTO series (id, title, folder, description, country, status, free_episode_limit, rating_average,
      rating_count, view_count, featured_order, total_episodes, thumbnail_url, source_created_at, source_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [s.id, s.title, s.folder, s.description, s.country, s.status, s.free_episode_limit, s.rating_average, s.rating_count,
      s.view_count, s.featured_order, s.total_episodes, s.cover_url, s.source_created_at, s.source_updated_at]);
  }
  for (const s of update) { // null di sumber tidak menimpa data yang sudah ada
    await dst.query(`UPDATE series SET description = COALESCE(?, description), country = COALESCE(?, country), status = COALESCE(?, status),
      free_episode_limit = COALESCE(?, free_episode_limit), rating_average = COALESCE(?, rating_average), rating_count = COALESCE(?, rating_count),
      view_count = COALESCE(?, view_count), total_episodes = COALESCE(?, total_episodes), source_created_at = COALESCE(source_created_at, ?)
      WHERE id = ?`,
    [s.description, s.country, s.status, s.free_episode_limit, s.rating_average, s.rating_count, s.view_count, s.total_episodes, s.source_created_at, s.id]);
  }
  await dst.commit();
} catch (e) { await dst.rollback(); throw e; }

const [[t]] = await dst.query('SELECT COUNT(*) n, COUNT(DISTINCT id) ids, COUNT(DISTINCT folder) folders, SUM(thumbnail_url IS NOT NULL) thumbs FROM series');
console.log(`SELESAI dewa_drama.series: ${t.n} baris, ${t.ids} id unik, ${t.folders} folder unik, ${t.thumbs} punya thumbnail`);
await src.end();
await dst.end();
