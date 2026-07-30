# Hướng dẫn đưa web app QC lên hosting cPanel

## 1. Tạo cơ sở dữ liệu MySQL trên cPanel
1. Vào cPanel → **MySQL® Databases**.
2. Tạo 1 database mới, ví dụ `user_qcapp`.
3. Tạo 1 user DB + mật khẩu mạnh, rồi **Add User To Database** với quyền **ALL PRIVILEGES**.
4. Ghi lại: tên database, tên user, mật khẩu.

## 2. Cấu hình app
1. Trong thư mục `web/`, sao chép `config.example.php` thành `config.php`.
2. Mở `config.php`, sửa:
   - `'driver' => 'mysql'`
   - Điền `host` (thường `localhost`), `database`, `username`, `password`.
   - Đổi `app_secret` thành một chuỗi ngẫu nhiên dài (mở khóa bảo mật session).

## 3. Upload
1. Upload **toàn bộ nội dung** thư mục `web/` vào `public_html/` (hoặc thư mục con, ví dụ `public_html/qc/`).
2. Đảm bảo có các file: `index.html`, `api.php`, `install.php`, `config.php`, `.htaccess`, thư mục `lib/`, `assets/`.

## 4. Cài đặt (chạy 1 lần)
1. Mở trình duyệt: `https://tenmien.com/qc/install.php` (đổi đường dẫn cho đúng).
2. Nhập tài khoản **Quản lý** đầu tiên (tên đăng nhập + mật khẩu).
3. Sau khi báo thành công → **XÓA file `install.php`** khỏi hosting.

## 5. Sử dụng
- Truy cập `https://tenmien.com/qc/` → đăng nhập.
- Quản lý vào menu **👥 Người dùng** để tạo tài khoản cho nhân viên QC.
- Tạo **dự án**, thêm thành viên, rồi thêm **công việc / nhiệm vụ con**.
- Mở trên **điện thoại**: vào cùng địa chỉ web, giao diện tự co giãn responsive.

## Bảo mật — quan trọng
- **KHÔNG** upload `config.php` lên nơi công khai (GitHub, file zip patch công khai...). File này chứa mật khẩu DB.
- `.htaccess` đã chặn truy cập trực tiếp `config.php`, `lib/`, `data/`.
- Mật khẩu người dùng được băm bằng `bcrypt` (không lưu dạng thô).
- Nếu dùng Cloudflare: nhớ **purge cache** sau mỗi lần cập nhật `assets/*.js` / `*.css`.

## Tài liệu / file tải lên
- File người dùng tải lên được lưu trong thư mục `uploads/` (tự tạo), tên file **ngẫu nhiên**, có `.htaccess` chặn truy cập trực tiếp và tắt PHP. Tải file chỉ qua `api.php?action=doc_download` (có kiểm tra quyền).
- **KHÔNG** cần tạo sẵn thư mục `uploads/`; app tự tạo. Chỉ cần thư mục web ghi được (thường mặc định trên cPanel).
- Muốn tải file lớn (tới 50MB), có thể phải chỉnh giới hạn PHP trên hosting. Tạo file `.user.ini` (hoặc chỉnh trong cPanel → MultiPHP INI Editor) với:
  ```
  upload_max_filesize = 50M
  post_max_size = 52M
  ```
- Định dạng cho phép: pdf, doc(x), xls(x), ppt(x), csv, txt, md, ảnh, zip/rar/7z, mp4/mov, json/xml/log. File thực thi (.php, .exe…) bị chặn.

## Nhắc nhở tự động (tùy chọn nâng cao)
Hiện nhắc nhở hiển thị **trong app** (chuông 🔔 + việc quá hạn tô đỏ). Muốn gửi nhắc qua **email/Zalo**,
cần thêm 1 file cron chạy định kỳ trên cPanel (Cron Jobs) — có thể bổ sung sau.
