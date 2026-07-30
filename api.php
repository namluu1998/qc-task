<?php
/**
 * API JSON cho ứng dụng Quản lý công việc QC.
 * Gọi qua: api.php?action=<tên_hành_động>
 * Xác thực bằng session cookie; thao tác ghi (POST) yêu cầu CSRF token.
 */
require_once __DIR__ . '/lib/helpers.php';
start_session();

header('X-Content-Type-Options: nosniff');

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

const PRIORITIES = ['Thấp', 'Trung bình', 'Cao', 'Khẩn cấp'];
const STATUSES   = ['Chưa test', 'Đang test', 'Đạt', 'Lỗi', 'Chờ xử lý'];
const ROLES      = ['manager', 'qc'];

// Mọi hành động POST (trừ login) bắt buộc có CSRF token hợp lệ.
if ($method === 'POST' && $action !== 'login') {
    require_csrf();
}

$now = fn() => date('Y-m-d H:i:s');

const UPLOAD_MAX = 52428800; // 50 MB
const ALLOWED_EXT = ['pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','png','jpg','jpeg','gif','webp','zip','rar','7z','mp4','mov','json','xml','log'];

/** Tạo bảng documents nếu chưa có (hoạt động cho cả cài mới lẫn cũ). */
function ensure_docs(): void
{
    static $done = false;
    if ($done) return;
    $pk = is_sqlite() ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    $suffix = is_sqlite() ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    db()->exec("CREATE TABLE IF NOT EXISTS documents (
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
    )$suffix");
    db()->exec("CREATE INDEX IF NOT EXISTS idx_docs_project ON documents (project_id)");
    $done = true;
}

function uploads_dir(): string
{
    $dir = __DIR__ . '/uploads';
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    // .htaccess chặn truy cập trực tiếp + tắt PHP trong thư mục upload
    $ht = $dir . '/.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Require all denied\nOrder deny,allow\nDeny from all\n<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n");
    }
    return $dir;
}

function rrmdir(string $dir): void
{
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = $dir . '/' . $f;
        is_dir($p) ? rrmdir($p) : @unlink($p);
    }
    @rmdir($dir);
}

try {
    switch ($action) {

        // ------------------------------------------------ Xác thực
        case 'login': {
            $b = body();
            $username = trim($b['username'] ?? '');
            $password = (string)($b['password'] ?? '');
            if ($username === '' || $password === '') {
                json_error('Nhập tên đăng nhập và mật khẩu.');
            }
            $stmt = db()->prepare('SELECT * FROM users WHERE username = ?');
            $stmt->execute([$username]);
            $u = $stmt->fetch();
            if (!$u || (int)$u['active'] !== 1 || !password_verify($password, $u['password_hash'])) {
                json_error('Sai tài khoản hoặc mật khẩu.', 401);
            }
            session_regenerate_id(true);
            $_SESSION['uid'] = (int)$u['id'];
            json_out([
                'ok'    => true,
                'user'  => ['id' => (int)$u['id'], 'username' => $u['username'], 'full_name' => $u['full_name'], 'role' => $u['role']],
                'csrf'  => csrf_token(),
            ]);
        }

        case 'logout': {
            $_SESSION = [];
            if (ini_get('session.use_cookies')) {
                $p = session_get_cookie_params();
                setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
            }
            session_destroy();
            json_out(['ok' => true]);
        }

        case 'me': {
            $u = current_user();
            if (!$u) {
                json_out(['ok' => true, 'user' => null]);
            }
            json_out([
                'ok'   => true,
                'user' => ['id' => (int)$u['id'], 'username' => $u['username'], 'full_name' => $u['full_name'], 'role' => $u['role']],
                'csrf' => csrf_token(),
                'meta' => ['priorities' => PRIORITIES, 'statuses' => STATUSES],
            ]);
        }

        // ------------------------------------------------ Dự án
        case 'projects': {
            $u = require_login();
            if ($u['role'] === 'manager') {
                $rows = db()->query('SELECT * FROM projects ORDER BY id DESC')->fetchAll();
            } else {
                $stmt = db()->prepare(
                    'SELECT p.* FROM projects p
                     JOIN project_members m ON m.project_id = p.id
                     WHERE m.user_id = ? ORDER BY p.id DESC'
                );
                $stmt->execute([$u['id']]);
                $rows = $stmt->fetchAll();
            }
            // Đếm số việc & việc chưa xong cho mỗi dự án.
            foreach ($rows as &$p) {
                $c = db()->prepare(
                    "SELECT COUNT(*) total,
                            SUM(CASE WHEN status <> 'Đạt' THEN 1 ELSE 0 END) open
                     FROM tasks WHERE project_id = ? AND parent_id IS NULL"
                );
                $c->execute([$p['id']]);
                $stat = $c->fetch();
                $p['total_tasks'] = (int)$stat['total'];
                $p['open_tasks']  = (int)($stat['open'] ?? 0);
                $p['id'] = (int)$p['id'];
            }
            json_out(['ok' => true, 'projects' => $rows]);
        }

        case 'project_save': {
            $u = require_manager();
            $b = body();
            $name = trim($b['name'] ?? '');
            if ($name === '') {
                json_error('Tên dự án không được để trống.');
            }
            $desc  = trim($b['description'] ?? '');
            $color = trim($b['color'] ?? '#2d7ff9');
            $members = array_values(array_unique(array_map('intval', $b['member_ids'] ?? [])));
            $id = (int)($b['id'] ?? 0);

            db()->beginTransaction();
            if ($id > 0) {
                $stmt = db()->prepare('UPDATE projects SET name=?, description=?, color=? WHERE id=?');
                $stmt->execute([$name, $desc, $color, $id]);
            } else {
                $stmt = db()->prepare(
                    'INSERT INTO projects (name, description, color, created_by, created_at) VALUES (?,?,?,?,?)'
                );
                $stmt->execute([$name, $desc, $color, $u['id'], $now()]);
                $id = (int)db()->lastInsertId();
            }
            // Cập nhật thành viên dự án.
            db()->prepare('DELETE FROM project_members WHERE project_id=?')->execute([$id]);
            $ins = db()->prepare('INSERT INTO project_members (project_id, user_id) VALUES (?,?)');
            foreach ($members as $uid) {
                $ins->execute([$id, $uid]);
            }
            db()->commit();
            json_out(['ok' => true, 'id' => $id]);
        }

        case 'project_delete': {
            require_manager();
            ensure_docs();
            $id = (int)(body()['id'] ?? 0);
            db()->beginTransaction();
            db()->prepare('DELETE FROM tasks WHERE project_id=?')->execute([$id]);
            db()->prepare('DELETE FROM project_members WHERE project_id=?')->execute([$id]);
            db()->prepare('DELETE FROM documents WHERE project_id=?')->execute([$id]);
            db()->prepare('DELETE FROM projects WHERE id=?')->execute([$id]);
            db()->commit();
            rrmdir(uploads_dir() . '/' . $id); // xóa file đã tải của dự án
            json_out(['ok' => true]);
        }

        case 'project_members': {
            $u = require_login();
            $pid = (int)($_GET['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) {
                json_error('Không có quyền truy cập dự án này.', 403);
            }
            $stmt = db()->prepare('SELECT user_id FROM project_members WHERE project_id=?');
            $stmt->execute([$pid]);
            json_out(['ok' => true, 'member_ids' => array_map('intval', array_column($stmt->fetchAll(), 'user_id'))]);
        }

        // ------------------------------------------------ Công việc / nhiệm vụ con
        case 'tasks': {
            $u = require_login();
            $pid = (int)($_GET['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) {
                json_error('Không có quyền truy cập dự án này.', 403);
            }
            $stmt = db()->prepare(
                "SELECT t.*, a.full_name AS assignee_name
                 FROM tasks t
                 LEFT JOIN users a ON a.id = t.assignee_id
                 WHERE t.project_id = ?
                 ORDER BY t.sort_order ASC, t.id ASC"
            );
            $stmt->execute([$pid]);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$t) {
                $t['id']          = (int)$t['id'];
                $t['project_id']  = (int)$t['project_id'];
                $t['parent_id']   = $t['parent_id'] !== null ? (int)$t['parent_id'] : null;
                $t['assignee_id'] = $t['assignee_id'] !== null ? (int)$t['assignee_id'] : null;
                $t['sort_order']  = (int)$t['sort_order'];
            }
            json_out(['ok' => true, 'tasks' => $rows]);
        }

        case 'task_save': {
            $u = require_login();
            $b = body();
            $pid = (int)($b['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) {
                json_error('Không có quyền truy cập dự án này.', 403);
            }
            $title = trim($b['title'] ?? '');
            if ($title === '') {
                json_error('Tên công việc không được để trống.');
            }
            $priority = in_array($b['priority'] ?? '', PRIORITIES, true) ? $b['priority'] : 'Trung bình';
            $status   = in_array($b['status'] ?? '', STATUSES, true) ? $b['status'] : 'Chưa test';
            $desc      = trim($b['description'] ?? '');
            $assignee  = !empty($b['assignee_id']) ? (int)$b['assignee_id'] : null;
            $due       = trim($b['due_date'] ?? '') ?: null;
            $remind    = trim($b['remind_at'] ?? '') ?: null;
            $parent    = !empty($b['parent_id']) ? (int)$b['parent_id'] : null;
            $id        = (int)($b['id'] ?? 0);

            if ($id > 0) {
                // Đảm bảo task thuộc đúng dự án người dùng có quyền.
                $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
                $chk->execute([$id]);
                $owner = $chk->fetchColumn();
                if ($owner === false || (int)$owner !== $pid) {
                    json_error('Không tìm thấy công việc.', 404);
                }
                $stmt = db()->prepare(
                    'UPDATE tasks SET title=?, description=?, priority=?, status=?, assignee_id=?, due_date=?, remind_at=?, updated_at=? WHERE id=?'
                );
                $stmt->execute([$title, $desc, $priority, $status, $assignee, $due, $remind, $now(), $id]);
            } else {
                $ord = db()->prepare('SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks WHERE project_id=?');
                $ord->execute([$pid]);
                $sort = (int)$ord->fetchColumn();
                $stmt = db()->prepare(
                    'INSERT INTO tasks (project_id, parent_id, title, description, priority, status, assignee_id, due_date, remind_at, sort_order, created_by, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
                );
                $stmt->execute([$pid, $parent, $title, $desc, $priority, $status, $assignee, $due, $remind, $sort, $u['id'], $now(), $now()]);
                $id = (int)db()->lastInsertId();
            }
            json_out(['ok' => true, 'id' => $id]);
        }

        case 'task_status': {
            $u = require_login();
            $b = body();
            $id = (int)($b['id'] ?? 0);
            $status = in_array($b['status'] ?? '', STATUSES, true) ? $b['status'] : null;
            if (!$status) {
                json_error('Trạng thái không hợp lệ.');
            }
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$id]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) {
                json_error('Không có quyền.', 403);
            }
            db()->prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?')->execute([$status, $now(), $id]);
            json_out(['ok' => true]);
        }

        case 'task_delete': {
            $u = require_login();
            $id = (int)(body()['id'] ?? 0);
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$id]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) {
                json_error('Không có quyền.', 403);
            }
            db()->beginTransaction();
            db()->prepare('DELETE FROM tasks WHERE parent_id=?')->execute([$id]); // xóa nhiệm vụ con
            db()->prepare('DELETE FROM tasks WHERE id=?')->execute([$id]);
            db()->commit();
            json_out(['ok' => true]);
        }

        case 'task_reorder': {
            $u = require_login();
            $b = body();
            $pid = (int)($b['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) {
                json_error('Không có quyền.', 403);
            }
            $ids = array_map('intval', $b['ordered_ids'] ?? []);
            db()->beginTransaction();
            $stmt = db()->prepare('UPDATE tasks SET sort_order=? WHERE id=? AND project_id=?');
            foreach ($ids as $i => $tid) {
                $stmt->execute([$i, $tid, $pid]);
            }
            db()->commit();
            json_out(['ok' => true]);
        }

        // ------------------------------------------------ Nhắc nhở
        case 'reminders': {
            $u = require_login();
            $today = date('Y-m-d');
            $soon  = date('Y-m-d', strtotime('+3 day'));
            // Việc chưa "Đạt", có hạn/nhắc, thuộc dự án mình truy cập; QC chỉ thấy việc được giao.
            $sql = "SELECT t.*, p.name AS project_name, a.full_name AS assignee_name
                    FROM tasks t
                    JOIN projects p ON p.id = t.project_id
                    LEFT JOIN users a ON a.id = t.assignee_id
                    WHERE t.status <> 'Đạt'
                      AND ( (t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date <= ?)
                            OR (t.remind_at IS NOT NULL AND t.remind_at <> '' AND t.remind_at <= ?) )";
            $params = [$soon, date('Y-m-d H:i:s')];
            if ($u['role'] !== 'manager') {
                $sql .= " AND t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)
                          AND (t.assignee_id = ? OR t.assignee_id IS NULL)";
                $params[] = $u['id'];
                $params[] = $u['id'];
            }
            $sql .= ' ORDER BY t.due_date ASC';
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$t) {
                $t['id'] = (int)$t['id'];
                $t['project_id'] = (int)$t['project_id'];
                $t['overdue'] = ($t['due_date'] && $t['due_date'] < $today);
            }
            json_out(['ok' => true, 'reminders' => $rows]);
        }

        // ------------------------------------------------ Lịch
        case 'calendar': {
            $u = require_login();
            $from = trim($_GET['from'] ?? '');
            $to   = trim($_GET['to'] ?? '');
            $sql = "SELECT t.id, t.title, t.status, t.priority, t.due_date, t.project_id, t.assignee_id,
                           p.name AS project_name, p.color AS project_color, a.full_name AS assignee_name
                    FROM tasks t
                    JOIN projects p ON p.id = t.project_id
                    LEFT JOIN users a ON a.id = t.assignee_id
                    WHERE t.due_date IS NOT NULL AND t.due_date <> ''";
            $params = [];
            if ($from !== '') { $sql .= " AND t.due_date >= ?"; $params[] = $from; }
            if ($to   !== '') { $sql .= " AND t.due_date <= ?"; $params[] = $to; }
            if ($u['role'] !== 'manager') {
                $sql .= " AND t.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?)";
                $params[] = $u['id'];
            }
            $sql .= " ORDER BY t.due_date ASC, t.id ASC";
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$t) {
                $t['id'] = (int)$t['id'];
                $t['project_id'] = (int)$t['project_id'];
                $t['assignee_id'] = $t['assignee_id'] !== null ? (int)$t['assignee_id'] : null;
                $t['due_date'] = substr($t['due_date'], 0, 10);
            }
            json_out(['ok' => true, 'tasks' => $rows]);
        }

        // ------------------------------------------------ Tài liệu dự án
        case 'documents': {
            $u = require_login();
            ensure_docs();
            $pid = (int)($_GET['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) json_error('Không có quyền truy cập dự án này.', 403);
            $stmt = db()->prepare(
                'SELECT d.id, d.kind, d.category, d.name, d.url, d.size, d.created_at, d.uploaded_by,
                        us.full_name AS uploader
                 FROM documents d LEFT JOIN users us ON us.id = d.uploaded_by
                 WHERE d.project_id = ? ORDER BY d.id DESC'
            );
            $stmt->execute([$pid]);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['size'] = (int)$r['size']; }
            json_out(['ok' => true, 'documents' => $rows]);
        }

        case 'doc_upload': {
            $u = require_login();
            ensure_docs();
            $pid = (int)($_POST['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) json_error('Không có quyền truy cập dự án này.', 403);
            if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
                json_error('Tải file thất bại (có thể vượt giới hạn dung lượng của máy chủ).');
            }
            $f = $_FILES['file'];
            if ($f['size'] <= 0 || $f['size'] > UPLOAD_MAX) json_error('File rỗng hoặc vượt quá 50MB.');
            $orig = $f['name'];
            $ext = strtolower(pathinfo($orig, PATHINFO_EXTENSION));
            if (!in_array($ext, ALLOWED_EXT, true)) json_error('Định dạng không được phép: .' . htmlspecialchars($ext));
            $base = uploads_dir();
            $dir = $base . '/' . $pid;
            if (!is_dir($dir)) mkdir($dir, 0775, true);
            $stored = bin2hex(random_bytes(16)) . '.' . $ext;
            if (!move_uploaded_file($f['tmp_name'], $dir . '/' . $stored)) json_error('Không lưu được file.', 500);
            $category = trim($_POST['category'] ?? 'Tài liệu') ?: 'Tài liệu';
            $stmt = db()->prepare(
                'INSERT INTO documents (project_id, kind, category, name, stored_name, size, uploaded_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([$pid, 'file', $category, $orig, $stored, (int)$f['size'], $u['id'], $now()]);
            json_out(['ok' => true, 'id' => (int)db()->lastInsertId()]);
        }

        case 'doc_link': {
            $u = require_login();
            ensure_docs();
            $b = body();
            $pid = (int)($b['project_id'] ?? 0);
            if (!can_access_project($u, $pid)) json_error('Không có quyền truy cập dự án này.', 403);
            $url = trim($b['url'] ?? '');
            if (!preg_match('~^https?://~i', $url)) json_error('Link phải bắt đầu bằng http:// hoặc https://');
            $name = trim($b['name'] ?? '') ?: $url;
            $category = trim($b['category'] ?? 'Tài liệu') ?: 'Tài liệu';
            $stmt = db()->prepare(
                'INSERT INTO documents (project_id, kind, category, name, url, uploaded_by, created_at)
                 VALUES (?,?,?,?,?,?,?)'
            );
            $stmt->execute([$pid, 'link', $category, $name, $url, $u['id'], $now()]);
            json_out(['ok' => true, 'id' => (int)db()->lastInsertId()]);
        }

        case 'doc_download': {
            $u = require_login();
            ensure_docs();
            $id = (int)($_GET['id'] ?? 0);
            $stmt = db()->prepare("SELECT * FROM documents WHERE id = ? AND kind = 'file'");
            $stmt->execute([$id]);
            $doc = $stmt->fetch();
            if (!$doc) json_error('Không tìm thấy tài liệu.', 404);
            if (!can_access_project($u, (int)$doc['project_id'])) json_error('Không có quyền.', 403);
            $path = uploads_dir() . '/' . (int)$doc['project_id'] . '/' . basename((string)$doc['stored_name']);
            if (!is_file($path)) json_error('File không tồn tại trên máy chủ.', 404);
            header('Content-Type: application/octet-stream');
            header('Content-Disposition: attachment; filename="' . rawurlencode($doc['name']) . '"');
            header('Content-Length: ' . filesize($path));
            header('X-Content-Type-Options: nosniff');
            readfile($path);
            exit;
        }

        case 'doc_delete': {
            $u = require_login();
            ensure_docs();
            $id = (int)(body()['id'] ?? 0);
            $stmt = db()->prepare('SELECT * FROM documents WHERE id = ?');
            $stmt->execute([$id]);
            $doc = $stmt->fetch();
            if (!$doc) json_error('Không tìm thấy tài liệu.', 404);
            if (!can_access_project($u, (int)$doc['project_id'])) json_error('Không có quyền.', 403);
            if ($u['role'] !== 'manager' && (int)$doc['uploaded_by'] !== (int)$u['id']) {
                json_error('Chỉ người đăng hoặc Quản lý mới được xóa.', 403);
            }
            if ($doc['kind'] === 'file' && $doc['stored_name']) {
                $path = uploads_dir() . '/' . (int)$doc['project_id'] . '/' . basename((string)$doc['stored_name']);
                if (is_file($path)) @unlink($path);
            }
            db()->prepare('DELETE FROM documents WHERE id = ?')->execute([$id]);
            json_out(['ok' => true]);
        }

        // ------------------------------------------------ Người dùng
        case 'users': {
            require_login();
            // Danh sách cơ bản để chọn người được giao việc.
            $rows = db()->query('SELECT id, username, full_name, role, active FROM users ORDER BY full_name')->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['active'] = (int)$r['active']; }
            json_out(['ok' => true, 'users' => $rows]);
        }

        case 'user_save': {
            require_manager();
            $b = body();
            $username = trim($b['username'] ?? '');
            $fullname = trim($b['full_name'] ?? '');
            $role = in_array($b['role'] ?? '', ROLES, true) ? $b['role'] : 'qc';
            $active = !empty($b['active']) ? 1 : 0;
            $password = (string)($b['password'] ?? '');
            $id = (int)($b['id'] ?? 0);
            if ($username === '') {
                json_error('Tên đăng nhập không được để trống.');
            }
            if ($id > 0) {
                if ($password !== '') {
                    if (strlen($password) < 6) json_error('Mật khẩu tối thiểu 6 ký tự.');
                    $stmt = db()->prepare('UPDATE users SET username=?, full_name=?, role=?, active=?, password_hash=? WHERE id=?');
                    $stmt->execute([$username, $fullname, $role, $active, password_hash($password, PASSWORD_DEFAULT), $id]);
                } else {
                    $stmt = db()->prepare('UPDATE users SET username=?, full_name=?, role=?, active=? WHERE id=?');
                    $stmt->execute([$username, $fullname, $role, $active, $id]);
                }
            } else {
                if (strlen($password) < 6) json_error('Mật khẩu tối thiểu 6 ký tự.');
                $exists = db()->prepare('SELECT 1 FROM users WHERE username=?');
                $exists->execute([$username]);
                if ($exists->fetchColumn()) json_error('Tên đăng nhập đã tồn tại.');
                $stmt = db()->prepare('INSERT INTO users (username, password_hash, full_name, role, active, created_at) VALUES (?,?,?,?,?,?)');
                $stmt->execute([$username, password_hash($password, PASSWORD_DEFAULT), $fullname ?: $username, $role, $active, $now()]);
                $id = (int)db()->lastInsertId();
            }
            json_out(['ok' => true, 'id' => $id]);
        }

        case 'user_delete': {
            $me = require_manager();
            $id = (int)(body()['id'] ?? 0);
            if ($id === (int)$me['id']) {
                json_error('Không thể xóa chính tài khoản đang đăng nhập.');
            }
            db()->prepare('DELETE FROM project_members WHERE user_id=?')->execute([$id]);
            db()->prepare('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?')->execute([$id]);
            db()->prepare('DELETE FROM users WHERE id=?')->execute([$id]);
            json_out(['ok' => true]);
        }

        default:
            json_error('Hành động không hợp lệ: ' . htmlspecialchars($action), 404);
    }
} catch (Throwable $e) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    json_error('Lỗi máy chủ: ' . $e->getMessage(), 500);
}
