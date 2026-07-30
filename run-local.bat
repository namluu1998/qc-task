@echo off
REM ============================================================
REM  Chay web app QC ngay tren may (PHP portable + SQLite).
REM  Khong can cai PHP hay MySQL. Chi can double-click file nay.
REM ============================================================
setlocal
set "PHP=%~dp0..\php-portable\php.exe"
set "INI=%~dp0..\php-portable\php.ini"

if not exist "%PHP%" (
  echo [LOI] Khong tim thay PHP portable tai:
  echo   %PHP%
  echo Hay chac chan thu muc php-portable nam canh thu muc web.
  pause
  exit /b 1
)

echo ============================================================
echo   QC Task - dang khoi dong server...
echo   Dia chi: http://localhost:8011
echo   (Lan dau chua co tai khoan: vao /install.php de tao)
echo   De DUNG server: dong cua so nay hoac nhan Ctrl+C
echo ============================================================

REM Tu mo trinh duyet sau 2 giay
start "" /min cmd /c "timeout /t 2 >nul & start http://localhost:8011/"

"%PHP%" -c "%INI%" -S localhost:8011 -t "%~dp0"
