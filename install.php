<?php
/**
 * Trình cài đặt chạy 1 lần: tạo bảng và tài khoản Quản lý đầu tiên.
 * Sau khi cài xong, nên XÓA file này khỏi hosting để an toàn.
 */
require_once __DIR__ . '/lib/helpers.php';
start_session();

/** Sinh câu lệnh CREATE TABLE phù hợp driver hiện tại. */
function schema_statements(): array
{
    $pk = is_sqlite()
        ? 'INTEGER PRIMARY KEY AUTOINCREMENT'
        : 'INT AUTO_INCREMENT PRIMARY KEY';
    $suffix = is_sqlite() ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';

    return [
        "CREATE TABLE IF NOT EXISTS users (
            id $pk,
            username      VARCHAR(60)  NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            full_name     VARCHAR(120) NOT NULL DEFAULT '',
            role          VARCHAR(20)  NOT NULL DEFAULT 'qc',
            active        INTEGER      NOT NULL DEFAULT 1,
            created_at    VARCHAR(25)  NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS projects (
            id $pk,
            name        VARCHAR(150) NOT NULL,
            description TEXT,
            color       VARCHAR(20)  NOT NULL DEFAULT '#2d7ff9',
            created_by  INTEGER      NOT NULL,
            created_at  VARCHAR(25)  NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS project_members (
            project_id INTEGER NOT NULL,
            user_id    INTEGER NOT NULL,
            PRIMARY KEY (project_id, user_id)
        )$suffix",

        "CREATE TABLE IF NOT EXISTS tasks (
            id $pk,
            project_id  INTEGER      NOT NULL,
            parent_id   INTEGER      DEFAULT NULL,
            title       VARCHAR(255) NOT NULL,
            description TEXT,
            priority    VARCHAR(20)  NOT NULL DEFAULT 'Trung bình',
            status      VARCHAR(20)  NOT NULL DEFAULT 'Chưa test',
            assignee_id INTEGER      DEFAULT NULL,
            due_date    VARCHAR(25)  DEFAULT NULL,
            remind_at   VARCHAR(25)  DEFAULT NULL,
            sort_order  INTEGER      NOT NULL DEFAULT 0,
            created_by  INTEGER      NOT NULL,
            created_at  VARCHAR(25)  NOT NULL,
            updated_at  VARCHAR(25)  NOT NULL
        )$suffix",

        "CREATE TABLE IF NOT EXISTS documents (
            id $pk,
            project_id  INTEGER      NOT NULL,
            kind        VARCHAR(10)  NOT NULL DEFAULT 'file',
            category    VARCHAR(40)  NOT NULL DEFAULT 'Tài liệu',
            name        VARCHAR(255) NOT NULL,
            url         TEXT,
            stored_name VARCHAR(255),
            size        INTEGER      DEFAULT 0,
            uploaded_by INTEGER      NOT NULL,
            created_at  VARCHAR(25)  NOT NULL
        )$suffix",

        "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id)",
        "CREATE INDEX IF NOT EXISTS idx_tasks_parent  ON tasks (parent_id)",
        "CREATE INDEX IF NOT EXISTS idx_members_user  ON project_members (user_id)",
        "CREATE INDEX IF NOT EXISTS idx_docs_project  ON documents (project_id)",
    ];
}

function already_installed(): bool
{
    try {
        return (bool) db()->query('SELECT 1 FROM users LIMIT 1');
    } catch (Throwable $e) {
        return false;
    }
}

$done = false;
$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $username = trim($_POST['username'] ?? '');
    $fullname = trim($_POST['full_name'] ?? '');
    $password = (string)($_POST['password'] ?? '');

    if ($username === '' || $password === '') {
        $error = 'Vui lòng nhập tên đăng nhập và mật khẩu.';
    } elseif (strlen($password) < 6) {
        $error = 'Mật khẩu phải từ 6 ký tự trở lên.';
    } else {
        try {
            foreach (schema_statements() as $sql) {
                db()->exec($sql);
            }
            // Chỉ tạo admin nếu chưa có user nào (tránh cài đè).
            $count = (int) db()->query('SELECT COUNT(*) FROM users')->fetchColumn();
            if ($count > 0) {
                $error = 'Hệ thống đã có tài khoản — không thể cài lại. Hãy xóa file install.php.';
            } else {
                $stmt = db()->prepare(
                    'INSERT INTO users (username, password_hash, full_name, role, active, created_at)
                     VALUES (?, ?, ?, ?, 1, ?)'
                );
                $stmt->execute([
                    $username,
                    password_hash($password, PASSWORD_DEFAULT),
                    $fullname !== '' ? $fullname : $username,
                    'manager',
                    date('Y-m-d H:i:s'),
                ]);
                $done = true;
            }
        } catch (Throwable $e) {
            $error = 'Lỗi cài đặt: ' . $e->getMessage();
        }
    }
}

$installed = already_installed();
?><!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cài đặt · QC Task</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;background:#f4f6fb;margin:0;padding:24px;color:#1e293b}
  .card{max-width:460px;margin:5vh auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:28px}
  h1{font-size:20px;margin:0 0 6px}
  p.sub{color:#64748b;margin:0 0 20px;font-size:14px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:15px}
  button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:9px;background:#2d7ff9;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .msg{padding:12px 14px;border-radius:9px;font-size:14px;margin-bottom:16px}
  .err{background:#fef2f2;color:#b91c1c}
  .ok{background:#ecfdf5;color:#047857}
  a{color:#2d7ff9}
</style>
</head>
<body>
<div class="card">
  <h1>Cài đặt hệ thống QC Task</h1>
  <p class="sub">Tạo tài khoản Quản lý đầu tiên. Chỉ chạy được một lần.</p>

  <?php if ($done): ?>
    <div class="msg ok">
      ✅ Cài đặt thành công! Hãy <b>xóa file install.php</b> khỏi hosting, rồi
      <a href="index.html">vào đăng nhập</a>.
    </div>
  <?php else: ?>
    <?php if ($error): ?><div class="msg err"><?= htmlspecialchars($error) ?></div><?php endif; ?>
    <?php if ($installed && !$error): ?>
      <div class="msg err">Hệ thống đã được cài. Hãy xóa file install.php và <a href="index.html">đăng nhập</a>.</div>
    <?php else: ?>
    <form method="post">
      <label>Tên đăng nhập</label>
      <input name="username" required autofocus>
      <label>Họ và tên</label>
      <input name="full_name">
      <label>Mật khẩu (tối thiểu 6 ký tự)</label>
      <input name="password" type="password" required>
      <button type="submit">Tạo tài khoản Quản lý</button>
    </form>
    <?php endif; ?>
  <?php endif; ?>
</div>
</body>
</html>
