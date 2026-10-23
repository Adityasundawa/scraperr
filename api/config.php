<?php
// Koneksi DB + helper bersama. Ubah lewat environment variable DB_* atau edit default (default = Laragon).
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

const COLS_SERIES = ['id', 'title', 'folder', 'description', 'country', 'status', 'free_episode_limit', 'rating_average',
    'rating_count', 'view_count', 'featured_order', 'total_episodes', 'cover_key', 'thumbnail_url', 'meta_url',
    'source_created_at', 'source_updated_at'];
const COLS_EPISODE = ['series_id', 'episode_number', 'source_episode_id', 'source_file', 'r2_key', 'url', 'size_bytes',
    'duration', 'status', 'error'];
const COLS_SUBTITLE = ['series_id', 'episode_number', 'language', 'r2_key', 'url'];

function out($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// baca api/.env (KEY=VALUE per baris, # = komentar). Environment variable asli tetap menang.
foreach (@file(__DIR__ . '/.env', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
    $line = trim($line);
    if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) continue;
    [$k, $v] = explode('=', $line, 2);
    $k = trim($k);
    if (getenv($k) === false) putenv($k . '=' . trim($v, " \t\"'"));
}

try {
    $pass = getenv('DB_PASS');
    $db = new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', getenv('DB_HOST') ?: '127.0.0.1', getenv('DB_PORT') ?: '3306', getenv('DB_NAME') ?: 'tadrama'),
        getenv('DB_USER') ?: 'root', $pass === false ? '' : $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
    );
} catch (PDOException $ex) {
    out(['error' => 'DB tidak bisa dibuka: ' . $ex->getMessage()], 500);
}

function body(): array {
    $j = json_decode(file_get_contents('php://input'), true);
    if (!is_array($j)) out(['error' => 'body harus JSON'], 400);
    return $j;
}

// insert, atau update kalau kunci unik sudah ada. Hanya kolom whitelist yang dikirim yang disentuh.
function upsert(PDO $db, string $table, array $row, array $cols): void {
    $row = array_intersect_key($row, array_flip($cols));
    foreach (['source_created_at', 'source_updated_at'] as $d) {
        if (array_key_exists($d, $row)) $row[$d] = $row[$d] ? gmdate('Y-m-d H:i:s', strtotime($row[$d])) : null; // ISO 8601 -> DATETIME
    }
    $names = array_keys($row);
    $sql = sprintf('INSERT INTO %s (%s) VALUES (%s) ON DUPLICATE KEY UPDATE %s', $table,
        implode(',', array_map(fn($c) => "`$c`", $names)),
        implode(',', array_fill(0, count($names), '?')),
        implode(',', array_map(fn($c) => "`$c`=VALUES(`$c`)", $names)));
    $db->prepare($sql)->execute(array_values($row));
}

// satu episode + subtitle-nya (opsional: "subtitles": [{language,r2_key,url}])
function saveEpisode(PDO $db, string $seriesId, array $e): void {
    if (!isset($e['episode_number'])) throw new InvalidArgumentException('episode_number wajib');
    $e['series_id'] = $seriesId;
    $e['status'] = $e['status'] ?? 'ok';
    upsert($db, 'episodes', $e, COLS_EPISODE);
    foreach ($e['subtitles'] ?? [] as $s) {
        upsert($db, 'subtitles', array_merge($s, ['series_id' => $seriesId, 'episode_number' => $e['episode_number']]), COLS_SUBTITLE);
    }
}
