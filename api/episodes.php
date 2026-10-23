<?php
// GET  episodes.php?series_id=<uuid>   -> episode milik series itu
// POST episodes.php {series_id,episode_number,url,...} atau array of itu -> upsert (series harus sudah ada)
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // dedup konten: cari episode ok lain dengan file sumber yang sama (series_id+episode_number = yang dikecualikan)
    if (isset($_GET['source_file'])) {
        $st = $db->prepare("SELECT r2_key, url, size_bytes FROM episodes WHERE source_file = ? AND status = 'ok'
            AND NOT (series_id = ? AND episode_number = ?) LIMIT 1");
        $st->execute([$_GET['source_file'], $_GET['series_id'] ?? '', (int)($_GET['episode_number'] ?? -1)]);
        out($st->fetch() ?: null);
    }
    if (empty($_GET['series_id'])) out(['error' => 'series_id wajib'], 400);
    $st = $db->prepare('SELECT * FROM episodes WHERE series_id = ? ORDER BY episode_number');
    $st->execute([$_GET['series_id']]);
    out($st->fetchAll());
}

if ($method === 'POST') {
    $b = body();
    $list = isset($b[0]) ? $b : [$b]; // satu episode atau banyak sekaligus
    try {
        $db->beginTransaction();
        foreach ($list as $e) {
            if (empty($e['series_id'])) throw new InvalidArgumentException('series_id wajib');
            saveEpisode($db, $e['series_id'], $e);
        }
        $db->commit();
    } catch (Throwable $ex) {
        if ($db->inTransaction()) $db->rollBack();
        out(['error' => $ex->getMessage()], 400);
    }
    out(['ok' => true, 'count' => count($list)]);
}

out(['error' => 'method tidak didukung'], 405);
