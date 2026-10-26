<?php
// GET  series.php?limit=50&offset=0&q=judul   -> daftar series
// GET  series.php?id=<uuid>                   -> detail + episode
// POST series.php  {id,title,folder,...,"episodes":[{episode_number,url,...,"subtitles":[...]}]} -> upsert (episodes opsional)
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if (!empty($_GET['id'])) {
        $st = $db->prepare('SELECT * FROM series WHERE id = ?');
        $st->execute([$_GET['id']]);
        $s = $st->fetch() ?: out(['error' => 'tidak ditemukan'], 404);
        $s['thumbnail_url'] = signMedia($s['thumbnail_url']);
        $s['meta_url'] = signMedia($s['meta_url']);
        $st = $db->prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY episode_number');
        $st->execute([$s['id']]);
        $eps = $st->fetchAll();
        foreach ($eps as &$e) if ($e['status'] === 'ok') $e['url'] = signMedia($e['url']);
        $s['episodes'] = $eps;
        out($s);
    }
    $st = $db->prepare('SELECT * FROM series WHERE title LIKE :q ORDER BY title LIMIT :l OFFSET :o');
    $st->bindValue(':q', '%' . trim($_GET['q'] ?? '') . '%');
    $st->bindValue(':l', min(max((int)($_GET['limit'] ?? 50), 1), 200), PDO::PARAM_INT);
    $st->bindValue(':o', max((int)($_GET['offset'] ?? 0), 0), PDO::PARAM_INT);
    $st->execute();
    $rows = $st->fetchAll();
    foreach ($rows as &$r) { $r['thumbnail_url'] = signMedia($r['thumbnail_url']); $r['meta_url'] = signMedia($r['meta_url']); }
    out($rows);
}

if ($method === 'POST') {
    $b = body();
    foreach (['id', 'title', 'folder'] as $k) {
        if (empty($b[$k])) out(['error' => "$k wajib"], 400);
    }
    try {
        $db->beginTransaction();
        upsert($db, 'series', $b, COLS_SERIES);
        foreach ($b['episodes'] ?? [] as $e) saveEpisode($db, $b['id'], $e);
        $db->commit();
    } catch (Throwable $ex) {
        if ($db->inTransaction()) $db->rollBack();
        out(['error' => $ex->getMessage()], 400);
    }
    out(['ok' => true, 'id' => $b['id'], 'episodes' => count($b['episodes'] ?? [])]);
}

out(['error' => 'method tidak didukung'], 405);
