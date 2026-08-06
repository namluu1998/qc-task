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
    try { db()->exec("ALTER TABLE documents ADD COLUMN task_id INTEGER DEFAULT NULL"); } catch (Throwable $e) {}
    $done = true;
}

/** Bảng bình luận + nhật ký hoạt động của task. */
function ensure_collab(): void
{
    static $done = false;
    if ($done) return;
    ensure_docs();
    $pk = is_sqlite() ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    $suffix = is_sqlite() ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    db()->exec("CREATE TABLE IF NOT EXISTS comments (
        id $pk, task_id INTEGER NOT NULL, user_id INTEGER NOT NULL, body TEXT NOT NULL, created_at VARCHAR(25) NOT NULL
    )$suffix");
    db()->exec("CREATE INDEX IF NOT EXISTS idx_comments_task ON comments (task_id)");
    db()->exec("CREATE TABLE IF NOT EXISTS activity (
        id $pk, task_id INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, created_at VARCHAR(25) NOT NULL
    )$suffix");
    db()->exec("CREATE INDEX IF NOT EXISTS idx_activity_task ON activity (task_id)");
    db()->exec("CREATE TABLE IF NOT EXISTS task_followers (
        task_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (task_id, user_id)
    )$suffix");
    $done = true;
}

function log_activity(int $taskId, ?int $uid, string $action): void
{
    ensure_collab();
    db()->prepare('INSERT INTO activity (task_id, user_id, action, created_at) VALUES (?,?,?,?)')
        ->execute([$taskId, $uid, $action, date('Y-m-d H:i:s')]);
}

function user_name(?int $id): string
{
    if (!$id) return '';
    static $cache = [];
    if (!array_key_exists($id, $cache)) {
        $s = db()->prepare('SELECT full_name FROM users WHERE id = ?');
        $s->execute([$id]);
        $cache[$id] = (string)($s->fetchColumn() ?: '');
    }
    return $cache[$id];
}

function fmt_size(int $b): string
{
    if ($b < 1024) return $b . ' B';
    if ($b < 1048576) return round($b / 1024) . ' KB';
    return round($b / 1048576, 1) . ' MB';
}

/** Thêm cột avatar cho users nếu chưa có. */
function ensure_user_columns(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    try { db()->exec("ALTER TABLE users ADD COLUMN avatar VARCHAR(255) DEFAULT NULL"); } catch (Throwable $e) {}
}

function avatars_dir(): string
{
    $dir = __DIR__ . '/avatars';
    if (!is_dir($dir)) mkdir($dir, 0775, true);
    $ht = $dir . '/.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Require all denied\nOrder deny,allow\nDeny from all\n<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n");
    }
    return $dir;
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

/** Thêm các cột bổ sung (completed_at, start_date) nếu chưa có — chạy 1 lần. */
function ensure_task_columns(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $add = function (string $col, string $def): bool {
        try { db()->exec("ALTER TABLE tasks ADD COLUMN $col $def"); return true; }
        catch (Throwable $e) { return false; /* cột đã tồn tại */ }
    };
    if ($add('completed_at', 'VARCHAR(25) DEFAULT NULL')) {
        // Vừa thêm: điền mốc hoàn thành cho task đã "Đạt" từ updated_at
        db()->exec("UPDATE tasks SET completed_at = updated_at WHERE status = 'Đạt' AND (completed_at IS NULL OR completed_at = '')");
    }
    $add('start_date', 'VARCHAR(25) DEFAULT NULL');
}

/** Bảng trạng thái (cấu hình được). Seed 5 trạng thái mặc định lần đầu. */
function ensure_statuses(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $pk = is_sqlite() ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INT AUTO_INCREMENT PRIMARY KEY';
    $suffix = is_sqlite() ? '' : ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    db()->exec("CREATE TABLE IF NOT EXISTS statuses (
        id $pk,
        name       VARCHAR(60) NOT NULL,
        color      VARCHAR(20) NOT NULL DEFAULT '#98a2b3',
        sort_order INTEGER     NOT NULL DEFAULT 0,
        is_done    INTEGER     NOT NULL DEFAULT 0
    )$suffix");
    if ((int)db()->query("SELECT COUNT(*) FROM statuses")->fetchColumn() === 0) {
        $seed = [
            ['Chưa test', '#98a2b3', 0, 0], ['Đang test', '#2563eb', 1, 0],
            ['Chờ xử lý', '#f5a623', 2, 0], ['Lỗi', '#e5484d', 3, 0], ['Đạt', '#12a150', 4, 1],
        ];
        $ins = db()->prepare("INSERT INTO statuses (name, color, sort_order, is_done) VALUES (?,?,?,?)");
        foreach ($seed as $s) $ins->execute($s);
    }
}

function status_defs(): array
{
    ensure_statuses();
    $rows = db()->query("SELECT id, name, color, sort_order, is_done FROM statuses ORDER BY sort_order, id")->fetchAll();
    foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['sort_order'] = (int)$r['sort_order']; $r['is_done'] = (int)$r['is_done']; }
    return $rows;
}
function status_names(): array { return array_column(status_defs(), 'name'); }
function done_status(): string
{
    foreach (status_defs() as $d) if ($d['is_done']) return $d['name'];
    $all = status_defs();
    return $all ? end($all)['name'] : 'Đạt';
}

try {
    ensure_user_columns();
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
                'user'  => ['id' => (int)$u['id'], 'username' => $u['username'], 'full_name' => $u['full_name'], 'role' => $u['role'], 'avatar' => $u['avatar'] ?? null],
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
                'user' => ['id' => (int)$u['id'], 'username' => $u['username'], 'full_name' => $u['full_name'], 'role' => $u['role'], 'avatar' => $u['avatar'] ?? null],
                'csrf' => csrf_token(),
                'meta' => ['priorities' => PRIORITIES, 'statuses' => status_names(), 'statusDefs' => status_defs()],
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
                            SUM(CASE WHEN status <> ? THEN 1 ELSE 0 END) open
                     FROM tasks WHERE project_id = ? AND parent_id IS NULL"
                );
                $c->execute([done_status(), $p['id']]);
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
                "SELECT t.*, a.full_name AS assignee_name, a.avatar AS assignee_avatar
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
            $statusList = status_names();
            $doneName   = done_status();
            $priority = in_array($b['priority'] ?? '', PRIORITIES, true) ? $b['priority'] : 'Trung bình';
            $status   = in_array($b['status'] ?? '', $statusList, true) ? $b['status'] : ($statusList[0] ?? 'Chưa test');
            $desc      = trim($b['description'] ?? '');
            $assignee  = !empty($b['assignee_id']) ? (int)$b['assignee_id'] : null;
            $start     = trim($b['start_date'] ?? '') ?: null;
            $due       = trim($b['due_date'] ?? '') ?: null;
            $remind    = trim($b['remind_at'] ?? '') ?: null;
            $parent    = !empty($b['parent_id']) ? (int)$b['parent_id'] : null;
            $id        = (int)($b['id'] ?? 0);

            ensure_task_columns();
            if ($id > 0) {
                // Đảm bảo task thuộc đúng dự án người dùng có quyền.
                $chk = db()->prepare('SELECT project_id, status, completed_at, assignee_id, description, priority, start_date, due_date FROM tasks WHERE id=?');
                $chk->execute([$id]);
                $cur = $chk->fetch();
                if (!$cur || (int)$cur['project_id'] !== $pid) {
                    json_error('Không tìm thấy công việc.', 404);
                }
                // Giữ mốc hoàn thành cũ nếu vẫn hoàn thành; đặt mới nếu vừa hoàn thành; xóa nếu mở lại
                if ($status === $doneName) {
                    $completed = !empty($cur['completed_at']) ? $cur['completed_at'] : $now();
                } else {
                    $completed = null;
                }
                $stmt = db()->prepare(
                    'UPDATE tasks SET title=?, description=?, priority=?, status=?, assignee_id=?, start_date=?, due_date=?, remind_at=?, updated_at=?, completed_at=? WHERE id=?'
                );
                $stmt->execute([$title, $desc, $priority, $status, $assignee, $start, $due, $remind, $now(), $completed, $id]);
                $uid = (int)$u['id'];
                if ($cur['status'] !== $status) log_activity($id, $uid, 'đổi trạng thái sang "' . $status . '"');
                if ((int)($cur['assignee_id'] ?? 0) !== (int)($assignee ?? 0)) {
                    log_activity($id, $uid, $assignee ? ('đổi người thực hiện: ' . user_name($assignee)) : 'bỏ người thực hiện');
                }
                if (($cur['priority'] ?? '') !== $priority) log_activity($id, $uid, 'đổi ưu tiên sang "' . $priority . '"');
                if (trim((string)($cur['description'] ?? '')) !== $desc) log_activity($id, $uid, 'cập nhật mô tả');
                if ((string)($cur['start_date'] ?? '') !== (string)($start ?? '')) log_activity($id, $uid, $start ? ('đặt ngày bắt đầu ' . substr($start, 0, 10)) : 'xóa ngày bắt đầu');
                if ((string)($cur['due_date'] ?? '') !== (string)($due ?? '')) log_activity($id, $uid, $due ? ('đặt hạn chót ' . substr($due, 0, 10)) : 'xóa hạn chót');
            } else {
                $ord = db()->prepare('SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks WHERE project_id=?');
                $ord->execute([$pid]);
                $sort = (int)$ord->fetchColumn();
                $completed = $status === $doneName ? $now() : null;
                $stmt = db()->prepare(
                    'INSERT INTO tasks (project_id, parent_id, title, description, priority, status, assignee_id, start_date, due_date, remind_at, sort_order, created_by, created_at, updated_at, completed_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
                );
                $stmt->execute([$pid, $parent, $title, $desc, $priority, $status, $assignee, $start, $due, $remind, $sort, $u['id'], $now(), $now(), $completed]);
                $id = (int)db()->lastInsertId();
                log_activity($id, (int)$u['id'], 'đã tạo công việc');
                if ($assignee) log_activity($id, (int)$u['id'], 'thêm người thực hiện: ' . user_name($assignee));
            }
            json_out(['ok' => true, 'id' => $id]);
        }

        case 'task_status': {
            $u = require_login();
            $b = body();
            $id = (int)($b['id'] ?? 0);
            $status = in_array($b['status'] ?? '', status_names(), true) ? $b['status'] : null;
            if (!$status) {
                json_error('Trạng thái không hợp lệ.');
            }
            ensure_task_columns();
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$id]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) {
                json_error('Không có quyền.', 403);
            }
            $completed = $status === done_status() ? $now() : null;   // ghi mốc hoàn thành / xóa khi mở lại
            db()->prepare('UPDATE tasks SET status=?, updated_at=?, completed_at=? WHERE id=?')
                ->execute([$status, $now(), $completed, $id]);
            log_activity($id, (int)$u['id'], 'đổi trạng thái sang "' . $status . '"');
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
            ensure_collab();
            // Gom id task + nhiệm vụ con để dọn dữ liệu liên quan
            $subs = db()->prepare('SELECT id FROM tasks WHERE parent_id=?'); $subs->execute([$id]);
            $ids = array_map('intval', $subs->fetchAll(PDO::FETCH_COLUMN)); $ids[] = $id;
            $inIds = implode(',', $ids);
            // Xóa file đính kèm của các task này (trên đĩa) + bản ghi
            $af = db()->query("SELECT project_id, stored_name FROM documents WHERE kind='file' AND task_id IN ($inIds) AND stored_name IS NOT NULL");
            foreach ($af->fetchAll() as $doc) {
                $p = uploads_dir() . '/' . (int)$doc['project_id'] . '/' . basename((string)$doc['stored_name']);
                if (is_file($p)) @unlink($p);
            }
            db()->beginTransaction();
            db()->exec("DELETE FROM documents WHERE task_id IN ($inIds)");
            db()->exec("DELETE FROM comments WHERE task_id IN ($inIds)");
            db()->exec("DELETE FROM activity WHERE task_id IN ($inIds)");
            db()->exec("DELETE FROM task_followers WHERE task_id IN ($inIds)");
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
                    WHERE t.status <> ?
                      AND ( (t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date <= ?)
                            OR (t.remind_at IS NOT NULL AND t.remind_at <> '' AND t.remind_at <= ?) )";
            $params = [done_status(), $soon, date('Y-m-d H:i:s')];
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
                 WHERE d.project_id = ? AND d.task_id IS NULL ORDER BY d.id DESC'
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
            $taskId = !empty($_POST['task_id']) ? (int)$_POST['task_id'] : null;
            $stmt = db()->prepare(
                'INSERT INTO documents (project_id, kind, category, name, stored_name, size, uploaded_by, created_at, task_id)
                 VALUES (?,?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([$pid, 'file', $category, $orig, $stored, (int)$f['size'], $u['id'], $now(), $taskId]);
            if ($taskId) log_activity($taskId, (int)$u['id'], 'đính kèm tệp "' . $orig . '" (' . fmt_size((int)$f['size']) . ')');
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
            $taskId = !empty($b['task_id']) ? (int)$b['task_id'] : null;
            $stmt = db()->prepare(
                'INSERT INTO documents (project_id, kind, category, name, url, uploaded_by, created_at, task_id)
                 VALUES (?,?,?,?,?,?,?,?)'
            );
            $stmt->execute([$pid, 'link', $category, $name, $url, $u['id'], $now(), $taskId]);
            if ($taskId) log_activity($taskId, (int)$u['id'], 'thêm liên kết "' . $name . '"');
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
            // Xem trước inline chỉ cho ảnh + PDF (an toàn); còn lại luôn tải về
            $ext = strtolower(pathinfo((string)$doc['stored_name'], PATHINFO_EXTENSION));
            $viewMime = [
                'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'pdf' => 'application/pdf',
                'txt' => 'text/plain; charset=utf-8', 'md' => 'text/plain; charset=utf-8', 'csv' => 'text/plain; charset=utf-8',
                'log' => 'text/plain; charset=utf-8', 'json' => 'text/plain; charset=utf-8', 'xml' => 'text/plain; charset=utf-8',
            ];
            $inline = (($_GET['disp'] ?? '') === 'inline') && isset($viewMime[$ext]);
            header('Content-Type: ' . ($inline ? $viewMime[$ext] : 'application/octet-stream'));
            header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . rawurlencode($doc['name']) . '"');
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
            if (!empty($doc['task_id'])) log_activity((int)$doc['task_id'], (int)$u['id'], ($doc['kind'] === 'file' ? 'xóa tệp "' : 'xóa liên kết "') . $doc['name'] . '"');
            db()->prepare('DELETE FROM documents WHERE id = ?')->execute([$id]);
            json_out(['ok' => true]);
        }

        case 'doc_update': {
            $u = require_login();
            ensure_docs();
            $b = body();
            $id = (int)($b['id'] ?? 0);
            $name = trim($b['name'] ?? '');
            if ($name === '') json_error('Tên tài liệu không được để trống.');
            $category = trim($b['category'] ?? '') ?: 'Tài liệu';
            $d = db()->prepare('SELECT project_id, uploaded_by FROM documents WHERE id = ?');
            $d->execute([$id]);
            $row = $d->fetch();
            if (!$row) json_error('Không tìm thấy tài liệu.', 404);
            if (!can_access_project($u, (int)$row['project_id'])) json_error('Không có quyền.', 403);
            if ($u['role'] !== 'manager' && (int)$row['uploaded_by'] !== (int)$u['id']) json_error('Chỉ người đăng hoặc Quản lý mới được sửa.', 403);
            db()->prepare('UPDATE documents SET name = ?, category = ? WHERE id = ?')->execute([$name, $category, $id]);
            json_out(['ok' => true]);
        }

        // ------------------------------------------------ Chi tiết task: bình luận + hoạt động + đính kèm
        case 'task_feed': {
            $u = require_login();
            ensure_collab();
            $tid = (int)($_GET['task_id'] ?? 0);
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$tid]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) json_error('Không có quyền.', 403);

            $cs = db()->prepare('SELECT c.id, c.body, c.created_at, c.user_id, us.full_name author, us.avatar author_avatar
                FROM comments c LEFT JOIN users us ON us.id = c.user_id WHERE c.task_id = ? ORDER BY c.id ASC');
            $cs->execute([$tid]);
            $comments = $cs->fetchAll();
            foreach ($comments as &$c) { $c['id'] = (int)$c['id']; $c['user_id'] = (int)$c['user_id']; }
            unset($c);

            $as = db()->prepare('SELECT a.action, a.created_at, us.full_name author
                FROM activity a LEFT JOIN users us ON us.id = a.user_id WHERE a.task_id = ? ORDER BY a.id DESC LIMIT 100');
            $as->execute([$tid]);
            $activity = $as->fetchAll();

            $ds = db()->prepare("SELECT id, kind, name, url, size, created_at FROM documents WHERE task_id = ? ORDER BY id DESC");
            $ds->execute([$tid]);
            $atts = $ds->fetchAll();
            foreach ($atts as &$d) { $d['id'] = (int)$d['id']; $d['size'] = (int)$d['size']; }
            unset($d);

            $fs = db()->prepare('SELECT us.id, us.full_name name, us.avatar FROM task_followers f LEFT JOIN users us ON us.id = f.user_id WHERE f.task_id = ?');
            $fs->execute([$tid]);
            $followers = $fs->fetchAll();
            $following = false;
            foreach ($followers as &$fr) { $fr['id'] = (int)$fr['id']; if ($fr['id'] === (int)$u['id']) $following = true; }
            unset($fr);

            json_out(['ok' => true, 'comments' => $comments, 'activity' => $activity, 'attachments' => $atts,
                'followers' => $followers, 'following' => $following,
                'me' => ['id' => (int)$u['id'], 'role' => $u['role']]]);
        }

        case 'follow_toggle': {
            $u = require_login();
            ensure_collab();
            $tid = (int)(body()['task_id'] ?? 0);
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$tid]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) json_error('Không có quyền.', 403);
            $ex = db()->prepare('SELECT 1 FROM task_followers WHERE task_id=? AND user_id=?');
            $ex->execute([$tid, $u['id']]);
            if ($ex->fetchColumn()) {
                db()->prepare('DELETE FROM task_followers WHERE task_id=? AND user_id=?')->execute([$tid, $u['id']]);
                log_activity($tid, (int)$u['id'], 'bỏ theo dõi');
                json_out(['ok' => true, 'following' => false]);
            } else {
                db()->prepare('INSERT INTO task_followers (task_id, user_id) VALUES (?,?)')->execute([$tid, $u['id']]);
                log_activity($tid, (int)$u['id'], 'theo dõi công việc');
                json_out(['ok' => true, 'following' => true]);
            }
        }

        case 'comment_add': {
            $u = require_login();
            ensure_collab();
            $b = body();
            $tid = (int)($b['task_id'] ?? 0);
            $text = trim($b['body'] ?? '');
            if ($text === '') json_error('Nội dung bình luận không được trống.');
            $chk = db()->prepare('SELECT project_id FROM tasks WHERE id=?');
            $chk->execute([$tid]);
            $pid = $chk->fetchColumn();
            if ($pid === false || !can_access_project($u, (int)$pid)) json_error('Không có quyền.', 403);
            db()->prepare('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?,?,?,?)')
                ->execute([$tid, $u['id'], $text, date('Y-m-d H:i:s')]);
            json_out(['ok' => true, 'id' => (int)db()->lastInsertId()]);
        }

        case 'comment_delete': {
            $u = require_login();
            ensure_collab();
            $id = (int)(body()['id'] ?? 0);
            $c = db()->prepare('SELECT c.user_id, t.project_id FROM comments c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?');
            $c->execute([$id]);
            $row = $c->fetch();
            if (!$row) json_error('Không tìm thấy bình luận.', 404);
            if (!can_access_project($u, (int)$row['project_id'])) json_error('Không có quyền.', 403);
            if ($u['role'] !== 'manager' && (int)$row['user_id'] !== (int)$u['id']) json_error('Chỉ người viết hoặc Quản lý mới xóa được.', 403);
            db()->prepare('DELETE FROM comments WHERE id=?')->execute([$id]);
            json_out(['ok' => true]);
        }

        // ------------------------------------------------ Việc của tôi (xuyên dự án)
        case 'my_tasks': {
            $u = require_login();
            ensure_task_columns();
            $scope = ($_GET['scope'] ?? 'assigned') === 'created' ? 'created' : 'assigned';
            if ($u['role'] === 'manager') {
                $projIds = db()->query('SELECT id FROM projects')->fetchAll(PDO::FETCH_COLUMN);
            } else {
                $st = db()->prepare('SELECT project_id FROM project_members WHERE user_id = ?');
                $st->execute([$u['id']]);
                $projIds = $st->fetchAll(PDO::FETCH_COLUMN);
            }
            $projIds = array_values(array_unique(array_map('intval', $projIds)));
            if (!$projIds) json_out(['ok' => true, 'tasks' => []]);
            $in = implode(',', $projIds);
            $col = $scope === 'created' ? 'created_by' : 'assignee_id';
            $stmt = db()->prepare(
                "SELECT t.id, t.title, t.status, t.priority, t.parent_id, t.start_date, t.due_date, t.project_id,
                        p.name project_name, p.color project_color, a.full_name assignee_name, a.avatar assignee_avatar
                 FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users a ON a.id = t.assignee_id
                 WHERE t.project_id IN ($in) AND t.$col = ? ORDER BY t.id DESC"
            );
            $stmt->execute([$u['id']]);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['project_id'] = (int)$r['project_id']; $r['parent_id'] = $r['parent_id'] !== null ? (int)$r['parent_id'] : null; }
            json_out(['ok' => true, 'tasks' => $rows]);
        }

        // ------------------------------------------------ Trung tâm tài liệu (mọi dự án)
        case 'documents_all': {
            $u = require_login();
            ensure_docs();
            if ($u['role'] === 'manager') {
                $projIds = db()->query('SELECT id FROM projects')->fetchAll(PDO::FETCH_COLUMN);
            } else {
                $st = db()->prepare('SELECT project_id FROM project_members WHERE user_id = ?');
                $st->execute([$u['id']]);
                $projIds = $st->fetchAll(PDO::FETCH_COLUMN);
            }
            $projIds = array_values(array_unique(array_map('intval', $projIds)));
            if (!$projIds) json_out(['ok' => true, 'documents' => []]);
            $in = implode(',', $projIds);
            $where = "d.project_id IN ($in) AND d.task_id IS NULL"; $params = [];
            $pid = (int)($_GET['project_id'] ?? 0);
            if ($pid) { $where .= ' AND d.project_id = ?'; $params[] = $pid; }
            $cat = trim($_GET['category'] ?? '');
            if ($cat !== '') { $where .= ' AND d.category = ?'; $params[] = $cat; }
            $kind = trim($_GET['kind'] ?? '');
            if ($kind === 'file' || $kind === 'link') { $where .= ' AND d.kind = ?'; $params[] = $kind; }
            $qs = trim($_GET['q'] ?? '');
            if ($qs !== '') { $where .= ' AND d.name LIKE ?'; $params[] = '%' . $qs . '%'; }
            $sortMap = ['new' => 'd.id DESC', 'name' => 'd.name ASC', 'size' => 'd.size DESC'];
            $orderBy = $sortMap[$_GET['sort'] ?? 'new'] ?? 'd.id DESC';
            $stmt = db()->prepare(
                "SELECT d.id, d.kind, d.category, d.name, d.url, d.size, d.created_at, d.project_id,
                        p.name project_name, p.color project_color, us.full_name uploader
                 FROM documents d JOIN projects p ON p.id = d.project_id LEFT JOIN users us ON us.id = d.uploaded_by
                 WHERE $where ORDER BY $orderBy LIMIT 500"
            );
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['size'] = (int)$r['size']; $r['project_id'] = (int)$r['project_id']; }
            json_out(['ok' => true, 'documents' => $rows]);
        }

        // ------------------------------------------------ Báo cáo (thống kê)
        case 'report': {
            $u = require_login();
            ensure_task_columns();
            if ($u['role'] === 'manager') {
                $projIds = db()->query('SELECT id FROM projects')->fetchAll(PDO::FETCH_COLUMN);
            } else {
                $st = db()->prepare('SELECT project_id FROM project_members WHERE user_id = ?');
                $st->execute([$u['id']]);
                $projIds = $st->fetchAll(PDO::FETCH_COLUMN);
            }
            $projIds = array_values(array_unique(array_map('intval', $projIds)));
            $from = trim($_GET['from'] ?? '');
            $to   = trim($_GET['to'] ?? '');
            $today = date('Y-m-d');
            $empty = [
                'from' => $from, 'to' => $to, 'created' => 0, 'completed' => 0, 'openNow' => 0, 'overdue' => 0,
                'byStatusNow' => [], 'completedByDay' => [], 'completedByProject' => [], 'completedByAssignee' => [], 'recentDone' => [],
            ];
            if (!$projIds) json_out(['ok' => true, 'report' => $empty]);
            $in = implode(',', $projIds); // toàn số nguyên đã ép kiểu -> an toàn

            // Điều kiện lọc theo kỳ trên phần ngày (10 ký tự đầu) của 1 cột thời gian
            $range = function (string $col) use ($from, $to) {
                $c = "substr($col,1,10)";
                if ($from !== '' && $to !== '') return [" AND $c BETWEEN ? AND ?", [$from, $to]];
                if ($from !== '') return [" AND $c >= ?", [$from]];
                if ($to   !== '') return [" AND $c <= ?", [$to]];
                return ['', []];
            };

            // Tạo mới trong kỳ (theo created_at)
            [$rc, $rp] = $range('created_at');
            $q = db()->prepare("SELECT COUNT(*) FROM tasks WHERE project_id IN ($in)$rc");
            $q->execute($rp); $created = (int)$q->fetchColumn();

            // Trạng thái "Hoàn thành" cấu hình được
            $done = done_status();

            // Hoàn thành trong kỳ (theo completed_at)
            [$cc, $cp] = $range('completed_at');
            $doneWhere = "project_id IN ($in) AND status = ? AND completed_at IS NOT NULL$cc";
            $doneParams = array_merge([$done], $cp);
            $q = db()->prepare("SELECT COUNT(*) FROM tasks WHERE $doneWhere");
            $q->execute($doneParams); $completed = (int)$q->fetchColumn();

            // Snapshot hiện tại (không phụ thuộc kỳ)
            $q = db()->prepare("SELECT COUNT(*) FROM tasks WHERE project_id IN ($in) AND status <> ?");
            $q->execute([$done]); $openNow = (int)$q->fetchColumn();
            $ov = db()->prepare("SELECT COUNT(*) FROM tasks WHERE project_id IN ($in) AND status <> ? AND due_date IS NOT NULL AND due_date<>'' AND due_date < ?");
            $ov->execute([$done, $today]); $overdue = (int)$ov->fetchColumn();
            $rowsSt = db()->query("SELECT status, COUNT(*) c FROM tasks WHERE project_id IN ($in) GROUP BY status")->fetchAll();
            $byStatusNow = []; foreach ($rowsSt as $r) $byStatusNow[$r['status']] = (int)$r['c'];

            // Hoàn thành theo ngày (xu hướng trong kỳ)
            $q = db()->prepare("SELECT substr(completed_at,1,10) d, COUNT(*) c FROM tasks WHERE $doneWhere GROUP BY substr(completed_at,1,10) ORDER BY d");
            $q->execute($doneParams);
            $completedByDay = array_map(fn($r) => ['date' => $r['d'], 'count' => (int)$r['c']], $q->fetchAll());

            // Hoàn thành theo dự án (trong kỳ)
            $q = db()->prepare("SELECT p.name, p.color, COUNT(t.id) c FROM tasks t JOIN projects p ON p.id=t.project_id
                WHERE t.project_id IN ($in) AND t.status = ? AND t.completed_at IS NOT NULL$cc GROUP BY p.id,p.name,p.color ORDER BY c DESC");
            $q->execute($doneParams);
            $completedByProject = array_map(fn($r) => ['name' => $r['name'], 'color' => $r['color'], 'count' => (int)$r['c']], $q->fetchAll());

            // Hoàn thành theo người thực hiện (trong kỳ)
            $q = db()->prepare("SELECT us.full_name name, COUNT(t.id) c FROM tasks t JOIN users us ON us.id=t.assignee_id
                WHERE t.project_id IN ($in) AND t.status = ? AND t.completed_at IS NOT NULL$cc GROUP BY us.id,us.full_name ORDER BY c DESC");
            $q->execute($doneParams);
            $completedByAssignee = array_map(fn($r) => ['name' => $r['name'], 'count' => (int)$r['c']], $q->fetchAll());

            // Đã hoàn thành gần đây (trong kỳ)
            $q = db()->prepare("SELECT t.id, t.project_id, t.title, t.completed_at, p.name project_name, us.full_name assignee
                FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users us ON us.id=t.assignee_id
                WHERE t.project_id IN ($in) AND t.status = ? AND t.completed_at IS NOT NULL$cc ORDER BY t.completed_at DESC LIMIT 12");
            $q->execute($doneParams);
            $recentDone = $q->fetchAll();
            foreach ($recentDone as &$rd) { $rd['id'] = (int)$rd['id']; $rd['project_id'] = (int)$rd['project_id']; }
            unset($rd);

            json_out(['ok' => true, 'report' => [
                'from' => $from, 'to' => $to,
                'created' => $created, 'completed' => $completed, 'openNow' => $openNow, 'overdue' => $overdue,
                'byStatusNow' => $byStatusNow, 'completedByDay' => $completedByDay,
                'completedByProject' => $completedByProject, 'completedByAssignee' => $completedByAssignee,
                'recentDone' => $recentDone,
            ]]);
        }

        // ------------------------------------------------ Chi tiết báo cáo (drill-down)
        case 'report_detail': {
            $u = require_login();
            ensure_task_columns();
            if ($u['role'] === 'manager') {
                $projIds = db()->query('SELECT id FROM projects')->fetchAll(PDO::FETCH_COLUMN);
            } else {
                $st = db()->prepare('SELECT project_id FROM project_members WHERE user_id = ?');
                $st->execute([$u['id']]);
                $projIds = $st->fetchAll(PDO::FETCH_COLUMN);
            }
            $projIds = array_values(array_unique(array_map('intval', $projIds)));
            if (!$projIds) json_out(['ok' => true, 'tasks' => []]);
            $in = implode(',', $projIds);
            $from = trim($_GET['from'] ?? ''); $to = trim($_GET['to'] ?? '');
            $type = $_GET['type'] ?? ''; $key = trim($_GET['key'] ?? '');
            $today = date('Y-m-d');
            $done = done_status();

            $where = "t.project_id IN ($in)"; $params = []; $order = 't.id DESC';
            $inRange = function (string $col) use ($from, $to, &$where, &$params) {
                $c = "substr($col,1,10)";
                if ($from !== '') { $where .= " AND $c >= ?"; $params[] = $from; }
                if ($to   !== '') { $where .= " AND $c <= ?"; $params[] = $to; }
            };
            switch ($type) {
                case 'created':
                    $inRange('t.created_at'); $order = 't.created_at DESC'; break;
                case 'completed':
                    $where .= " AND t.status = ? AND t.completed_at IS NOT NULL"; $params[] = $done;
                    $inRange('t.completed_at'); $order = 't.completed_at DESC'; break;
                case 'project_completed':
                    $where .= " AND t.status = ? AND t.completed_at IS NOT NULL AND p.name = ?"; $params[] = $done; $params[] = $key;
                    $inRange('t.completed_at'); $order = 't.completed_at DESC'; break;
                case 'assignee_completed':
                    $where .= " AND t.status = ? AND t.completed_at IS NOT NULL AND us.full_name = ?"; $params[] = $done; $params[] = $key;
                    $inRange('t.completed_at'); $order = 't.completed_at DESC'; break;
                case 'open':
                    $where .= " AND t.status <> ?"; $params[] = $done; break;
                case 'overdue':
                    $where .= " AND t.status <> ? AND t.due_date IS NOT NULL AND t.due_date <> '' AND t.due_date < ?";
                    $params[] = $done; $params[] = $today; $order = 't.due_date ASC'; break;
                case 'status':
                    $where .= " AND t.status = ?"; $params[] = $key; break;
                default:
                    json_error('Loại chi tiết không hợp lệ.');
            }
            $sql = "SELECT t.id, t.project_id, t.title, t.status, t.priority, t.start_date, t.due_date, t.completed_at, t.created_at,
                           p.name project_name, us.full_name assignee
                    FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users us ON us.id = t.assignee_id
                    WHERE $where ORDER BY $order LIMIT 300";
            $stmt = db()->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['project_id'] = (int)$r['project_id']; }
            json_out(['ok' => true, 'tasks' => $rows]);
        }

        // ------------------------------------------------ Cài đặt trạng thái
        case 'status_save': {
            require_manager();
            ensure_statuses();
            $b = body();
            $name = trim($b['name'] ?? '');
            if ($name === '') json_error('Tên trạng thái không được để trống.');
            $color  = trim($b['color'] ?? '') ?: '#98a2b3';
            $isDone = !empty($b['is_done']) ? 1 : 0;
            $id     = (int)($b['id'] ?? 0);
            $chk = db()->prepare('SELECT id FROM statuses WHERE name = ? AND id <> ?');
            $chk->execute([$name, $id]);
            if ($chk->fetchColumn()) json_error('Tên trạng thái đã tồn tại.');

            db()->beginTransaction();
            if ($id > 0) {
                $old = db()->prepare('SELECT name FROM statuses WHERE id=?');
                $old->execute([$id]);
                $oldName = $old->fetchColumn();
                if ($oldName === false) { db()->rollBack(); json_error('Không tìm thấy trạng thái.', 404); }
                db()->prepare('UPDATE statuses SET name=?, color=?, is_done=? WHERE id=?')->execute([$name, $color, $isDone, $id]);
                if ($oldName !== $name) {
                    db()->prepare('UPDATE tasks SET status=? WHERE status=?')->execute([$name, $oldName]); // đổi tên -> cập nhật task đang dùng
                }
            } else {
                $ord = (int)db()->query('SELECT COALESCE(MAX(sort_order),0)+1 FROM statuses')->fetchColumn();
                db()->prepare('INSERT INTO statuses (name, color, sort_order, is_done) VALUES (?,?,?,?)')->execute([$name, $color, $ord, $isDone]);
                $id = (int)db()->lastInsertId();
            }
            if ($isDone) db()->prepare('UPDATE statuses SET is_done=0 WHERE id<>?')->execute([$id]); // chỉ 1 trạng thái "Hoàn thành"
            db()->commit();
            json_out(['ok' => true, 'id' => $id, 'statusDefs' => status_defs()]);
        }

        case 'status_delete': {
            require_manager();
            ensure_statuses();
            $id = (int)(body()['id'] ?? 0);
            $defs = status_defs();
            if (count($defs) <= 1) json_error('Phải giữ ít nhất 1 trạng thái.');
            $row = null; foreach ($defs as $d) if ($d['id'] === $id) $row = $d;
            if (!$row) json_error('Không tìm thấy trạng thái.', 404);
            if ($row['is_done']) json_error('Không thể xóa trạng thái "Hoàn thành". Hãy đặt trạng thái khác làm Hoàn thành trước.');
            $fallback = '';
            foreach ($defs as $d) if ($d['id'] !== $id) { $fallback = $d['name']; break; }
            db()->beginTransaction();
            db()->prepare('UPDATE tasks SET status=? WHERE status=?')->execute([$fallback, $row['name']]); // dời task sang trạng thái khác
            db()->prepare('DELETE FROM statuses WHERE id=?')->execute([$id]);
            db()->commit();
            json_out(['ok' => true, 'reassignedTo' => $fallback, 'statusDefs' => status_defs()]);
        }

        case 'status_reorder': {
            require_manager();
            ensure_statuses();
            $ids = array_map('intval', body()['ordered_ids'] ?? []);
            db()->beginTransaction();
            $st = db()->prepare('UPDATE statuses SET sort_order=? WHERE id=?');
            foreach ($ids as $i => $sid) $st->execute([$i, $sid]);
            db()->commit();
            json_out(['ok' => true, 'statusDefs' => status_defs()]);
        }

        // ------------------------------------------------ Người dùng
        case 'users': {
            require_login();
            // Danh sách cơ bản để chọn người được giao việc.
            $rows = db()->query('SELECT id, username, full_name, role, active, avatar FROM users ORDER BY full_name')->fetchAll();
            // Đếm số việc đang mở của mỗi người (1 truy vấn)
            $cq = db()->prepare("SELECT assignee_id, COUNT(*) c FROM tasks WHERE status <> ? AND assignee_id IS NOT NULL GROUP BY assignee_id");
            $cq->execute([done_status()]);
            $countMap = [];
            foreach ($cq->fetchAll() as $cr) $countMap[(int)$cr['assignee_id']] = (int)$cr['c'];
            foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['active'] = (int)$r['active']; $r['open_tasks'] = $countMap[$r['id']] ?? 0; }
            json_out(['ok' => true, 'users' => $rows]);
        }

        // ------------------------------------------------ Hồ sơ cá nhân
        case 'profile_save': {
            $u = require_login();
            $name = trim(body()['full_name'] ?? '');
            if ($name === '') json_error('Họ tên không được để trống.');
            db()->prepare('UPDATE users SET full_name=? WHERE id=?')->execute([$name, $u['id']]);
            json_out(['ok' => true]);
        }

        case 'change_password': {
            $u = require_login();
            $b = body();
            $cur = (string)($b['current_password'] ?? '');
            $new = (string)($b['new_password'] ?? '');
            if (strlen($new) < 6) json_error('Mật khẩu mới phải từ 6 ký tự trở lên.');
            $s = db()->prepare('SELECT password_hash FROM users WHERE id=?');
            $s->execute([$u['id']]);
            $hash = $s->fetchColumn();
            if (!$hash || !password_verify($cur, $hash)) json_error('Mật khẩu hiện tại không đúng.');
            db()->prepare('UPDATE users SET password_hash=? WHERE id=?')->execute([password_hash($new, PASSWORD_DEFAULT), $u['id']]);
            json_out(['ok' => true]);
        }

        case 'avatar_upload': {
            $u = require_login();
            if (empty($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) json_error('Tải ảnh thất bại.');
            $f = $_FILES['file'];
            if ($f['size'] <= 0 || $f['size'] > 5 * 1024 * 1024) json_error('Ảnh rỗng hoặc vượt quá 5MB.');
            $ext = strtolower(pathinfo($f['name'], PATHINFO_EXTENSION));
            if (!in_array($ext, ['png', 'jpg', 'jpeg', 'gif', 'webp'], true)) json_error('Chỉ nhận ảnh (png/jpg/gif/webp).');
            $dir = avatars_dir();
            $old = db()->prepare('SELECT avatar FROM users WHERE id=?'); $old->execute([$u['id']]);
            $oldName = $old->fetchColumn();
            if ($oldName && is_file($dir . '/' . basename((string)$oldName))) @unlink($dir . '/' . basename((string)$oldName));
            $stored = 'u' . (int)$u['id'] . '_' . time() . '.' . $ext;
            if (!move_uploaded_file($f['tmp_name'], $dir . '/' . $stored)) json_error('Không lưu được ảnh.', 500);
            db()->prepare('UPDATE users SET avatar=? WHERE id=?')->execute([$stored, $u['id']]);
            json_out(['ok' => true, 'avatar' => $stored]);
        }

        case 'avatar_remove': {
            $u = require_login();
            $old = db()->prepare('SELECT avatar FROM users WHERE id=?'); $old->execute([$u['id']]);
            $oldName = $old->fetchColumn();
            if ($oldName && is_file(avatars_dir() . '/' . basename((string)$oldName))) @unlink(avatars_dir() . '/' . basename((string)$oldName));
            db()->prepare('UPDATE users SET avatar=NULL WHERE id=?')->execute([$u['id']]);
            json_out(['ok' => true]);
        }

        case 'avatar': {
            require_login();
            $id = (int)($_GET['id'] ?? 0);
            $s = db()->prepare('SELECT avatar FROM users WHERE id=?'); $s->execute([$id]);
            $av = $s->fetchColumn();
            if (!$av) json_error('Không có ảnh.', 404);
            $path = avatars_dir() . '/' . basename((string)$av);
            if (!is_file($path)) json_error('Ảnh không tồn tại.', 404);
            $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            $mime = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp'][$ext] ?? 'application/octet-stream';
            header('Content-Type: ' . $mime);
            header('Cache-Control: private, max-age=3600');
            header('Content-Length: ' . filesize($path));
            readfile($path);
            exit;
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
