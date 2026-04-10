@echo off
setlocal

cd /d E:\vedereyue
set "NODE_EXE=D:\Program Files\nodejs\node.exe"

set "STATUS_OK="
for /f %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; try { $resp = Invoke-RestMethod -Uri ''http://127.0.0.1:3000/api/status'' -TimeoutSec 2; if ($resp.ok -eq $true) { $ok = $true } } catch {}; if ($ok) { Write-Output 1 } else { Write-Output 0 }"') do set "STATUS_OK=%%i"

if not "%STATUS_OK%"=="1" (
  start "USD1 Monitor Server" /min cmd /c "cd /d E:\vedereyue && ""%NODE_EXE%"" server.js"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 4"
)

start "" "http://127.0.0.1:3000"

endlocal
