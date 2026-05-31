@echo off
cd /d "%~dp0"
echo ====================================================
echo   TuanTuan LOCAL TEST  (demo mode, no backend)
echo ====================================================
echo.
echo  Admin    : admin.html     admin / admin123
echo  Merchant : merchant.html  shop1..shop4 / 1234
echo  Customer : index.html     no login, fill profile
echo.
echo  Which shop is which + full guide: see TESTING.md
echo  Close the popup "TuanTuan server" window to stop.
echo.
start "TuanTuan server (close to stop)" cmd /k "python -m http.server 8777"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8777/index.html?demo"
start "" "http://localhost:8777/merchant.html?demo"
start "" "http://localhost:8777/admin.html?demo"
echo Opened customer / merchant / admin in your browser.
echo This window can be closed.
timeout /t 6 /nobreak >nul
