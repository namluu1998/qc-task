# QC Task — Quản lý công việc kiểm thử

Ứng dụng web quản lý công việc cho nhóm **QC**: đa người dùng có phân quyền, chia nhiều dự án, công việc + nhiệm vụ con, nhắc nhở, lịch, và tài liệu dự án. Giao diện responsive (dùng được trên điện thoại). Deploy đơn giản lên hosting **cPanel (PHP + MySQL)**.

## Tính năng
- 🔐 **Đăng nhập** đa người dùng, phân quyền **Quản lý / Nhân viên QC**
- 📁 **Nhiều dự án**, kiểm soát thành viên truy cập từng dự án
- ✅ **Công việc + nhiệm vụ con**, trạng thái QC (Chưa test / Đang test / Đạt / Lỗi / Chờ xử lý), mức độ ưu tiên
- 🔀 **Sắp xếp**: kéo-thả thủ công, nút ▲▼, hoặc tự sắp theo ưu tiên/hạn/trạng thái; kéo sang nhóm khác để đổi trạng thái
- 🔔 **Nhắc nhở** việc đến hạn / quá hạn
- 📅 **Lịch** xem công việc theo hạn chót (tất cả dự án)
- 📎 **Tài liệu dự án**: tải file lên hoặc thêm link (Tài liệu / Test case / Kết quả test…)
- 📱 **Responsive** — xem tốt trên điện thoại

## Công nghệ
- **PHP (PDO)** + **MySQL/MariaDB** (production) — chạy được cả **SQLite** để test cục bộ
- Frontend **HTML + CSS + JavaScript thuần** (SPA gọi `api.php` qua fetch)
- Xác thực bằng session cookie + **CSRF token**; mật khẩu băm **bcrypt**

## Cấu trúc
```
index.html          Giao diện (SPA)
api.php             API JSON (đăng nhập, dự án, công việc, lịch, tài liệu, người dùng)
install.php         Cài đặt 1 lần: tạo bảng + tài khoản Quản lý đầu tiên
config.example.php  Mẫu cấu hình — sao chép thành config.php và điền thông tin DB
lib/                Kết nối DB (PDO) + hàm tiện ích (session, CSRF, phân quyền)
assets/             app.js, style.css
.htaccess           Bảo mật (chặn config.php, lib, data, uploads; header an toàn)
DEPLOY.md           Hướng dẫn deploy lên cPanel
```

## Cài đặt nhanh (local)
Cần PHP (có sẵn `pdo_sqlite`). Sao chép `config.example.php` → `config.php` (để `driver => 'sqlite'`), rồi:
```bash
php -S localhost:8011
```
Mở `http://localhost:8011/install.php` để tạo tài khoản Quản lý, sau đó xóa `install.php`.

## Deploy lên hosting
Xem [DEPLOY.md](DEPLOY.md) — tạo MySQL DB trên cPanel, điền `config.php` (`driver => 'mysql'`), upload thư mục này, chạy `install.php` rồi xóa.

## Bảo mật
- **Không commit `config.php`** (chứa mật khẩu DB) — đã có trong `.gitignore`.
- File tải lên lưu tên ngẫu nhiên trong `uploads/`, chặn truy cập trực tiếp + tắt PHP, tải qua endpoint có kiểm tra quyền.
- Prepared statements (PDO) chống SQL injection; CSRF cho mọi thao tác ghi.
