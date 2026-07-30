<?php
/**
 * Sao chép file này thành "config.php" rồi điền thông tin thật.
 * KHÔNG commit / KHÔNG upload công khai file config.php (chứa mật khẩu DB).
 */
return [
    // 'mysql' cho hosting cPanel  |  'sqlite' để chạy thử cục bộ
    'driver' => 'mysql',

    // --- Cấu hình MySQL / MariaDB (dùng khi driver = mysql) ---
    'mysql' => [
        'host'     => 'localhost',
        'port'     => 3306,
        'database' => 'ten_database',   // ví dụ: user_qcapp
        'username' => 'ten_user_db',
        'password' => 'mat_khau_db',
        'charset'  => 'utf8mb4',
    ],

    // --- Cấu hình SQLite (dùng khi driver = sqlite, để test cục bộ) ---
    'sqlite' => [
        'path' => __DIR__ . '/data/qc.sqlite',
    ],

    // Chuỗi bí mật cho session/CSRF — ĐỔI thành chuỗi ngẫu nhiên dài khi deploy.
    'app_secret' => 'DOI_CHUOI_NAY_THANH_NGAU_NHIEN_DAI',
];
