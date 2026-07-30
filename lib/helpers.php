<?php
/** Hàm tiện ích: session, JSON, xác thực, CSRF, phân quyền. */

require_once __DIR__ . '/db.php';

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }
    // Cookie session an toàn: HttpOnly + SameSite=Lax; bật Secure khi chạy HTTPS.
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $secure,
    ]);
    session_name('QCSESSID');
    session_start();
}

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function json_error(string $message, int $code = 400): void
{
    json_out(['ok' => false, 'error' => $message], $code);
}

/** Đọc body JSON của request POST. */
function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/** ---- CSRF ---- */
function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf'];
}

function require_csrf(): void
{
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $sent)) {
        json_error('CSRF token không hợp lệ. Hãy tải lại trang và đăng nhập lại.', 419);
    }
}

/** ---- Xác thực ---- */
function current_user(): ?array
{
    if (empty($_SESSION['uid'])) {
        return null;
    }
    static $u = null;
    if ($u === null) {
        $stmt = db()->prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?');
        $stmt->execute([$_SESSION['uid']]);
        $u = $stmt->fetch() ?: null;
    }
    return $u;
}

function require_login(): array
{
    $u = current_user();
    if (!$u || (int)$u['active'] !== 1) {
        json_error('Bạn cần đăng nhập.', 401);
    }
    return $u;
}

function require_manager(): array
{
    $u = require_login();
    if ($u['role'] !== 'manager') {
        json_error('Chỉ Quản lý mới được thực hiện thao tác này.', 403);
    }
    return $u;
}

/** Người dùng có quyền truy cập dự án này không? (thành viên hoặc quản lý) */
function can_access_project(array $user, int $project_id): bool
{
    if ($user['role'] === 'manager') {
        return true;
    }
    $stmt = db()->prepare(
        'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?'
    );
    $stmt->execute([$project_id, $user['id']]);
    return (bool)$stmt->fetchColumn();
}
