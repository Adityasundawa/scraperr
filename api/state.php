<?php
// GET state.php -> ringkasan untuk scraper: progres per series, total per status, total ukuran file unik di R2
require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') out(['error' => 'method tidak didukung'], 405);

$series = $db->query("SELECT s.id, s.folder, s.cover_key, s.total_episodes, COALESCE(SUM(e.status = 'ok'), 0) ok
    FROM series s LEFT JOIN episodes e ON e.series_id = s.id GROUP BY s.id")->fetchAll();
foreach ($series as &$s) {
    $s['total_episodes'] = (int)$s['total_episodes'];
    $s['ok'] = (int)$s['ok'];
}
unset($s);

$t = $db->query("SELECT COALESCE(SUM(status = 'ok'), 0) ok, COALESCE(SUM(status = 'locked'), 0) locked,
    COALESCE(SUM(status = 'error'), 0) error FROM episodes")->fetch();
$bytes = $db->query("SELECT COALESCE(SUM(size_bytes), 0) FROM (SELECT DISTINCT r2_key, size_bytes FROM episodes WHERE status = 'ok') x")->fetchColumn();

out(['series' => $series, 'totals' => array_map('intval', $t), 'used_bytes' => (int)$bytes]);
