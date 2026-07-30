<?php
/**
 * Kết nối cơ sở dữ liệu qua PDO. Hỗ trợ MySQL (production) và SQLite (test cục bộ).
 * Dùng prepared statements ở mọi nơi để chống SQL injection.
 */

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $path = __DIR__ . '/../config.php';
        if (!file_exists($path)) {
            http_response_code(500);
            die('Thiếu file config.php. Hãy sao chép config.example.php thành config.php.');
        }
        $cfg = require $path;
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }

    $cfg = config();
    $driver = $cfg['driver'] ?? 'mysql';
    $options = [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ];

    if ($driver === 'sqlite') {
        $spath = $cfg['sqlite']['path'];
        $dir = dirname($spath);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        $pdo = new PDO('sqlite:' . $spath, null, null, $options);
        $pdo->exec('PRAGMA foreign_keys = ON');
    } else {
        $m = $cfg['mysql'];
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $m['host'], $m['port'], $m['database'], $m['charset']
        );
        $pdo = new PDO($dsn, $m['username'], $m['password'], $options);
    }

    return $pdo;
}

/** Trả về true nếu đang chạy trên SQLite (dùng để chọn cú pháp SQL khác biệt). */
function is_sqlite(): bool
{
    return (config()['driver'] ?? 'mysql') === 'sqlite';
}
