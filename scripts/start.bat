@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

set DATA_DIR=.data
set PID_FILE=%DATA_DIR%\server.pid
set LOG_FILE=%DATA_DIR%\server.log
set PORT=51777

echo.
echo   Claude Kanban - Start
echo.

if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"

:: --- Already running? ---
if exist "%PID_FILE%" (
  set /p OLD_PID=<"%PID_FILE%"
  tasklist /fi "PID eq !OLD_PID!" 2>nul | find "node" >nul 2>nul
  if !errorlevel! equ 0 (
    echo   [OK]   Already running ^(PID !OLD_PID!^) at http://localhost:%PORT%
    exit /b 0
  )
  del /f "%PID_FILE%" >nul 2>nul
)

:: --- Node.js ---
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo   [..]   Node.js not found - installing via winget...
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -h
  if !errorlevel! neq 0 (
    echo   [FAIL] Node.js install failed. Install manually: https://nodejs.org
    exit /b 1
  )
  echo.
  echo   Node.js installed. Close this window, open a new terminal, and re-run start.bat
  echo   ^(PATH needs to refresh to find node^)
  exit /b 0
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo   [OK]   Node.js %NODE_VER%

:: --- pnpm ---
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
  echo   [..]   Installing pnpm...
  call npm install -g pnpm >nul 2>nul
)
for /f "tokens=*" %%v in ('pnpm -v 2^>nul') do set PNPM_VER=%%v
echo   [OK]   pnpm %PNPM_VER%

:: --- Claude CLI ---
where claude >nul 2>nul
if %errorlevel% equ 0 (
  echo   [OK]   Claude CLI found
) else (
  echo   [WARN] Claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code
  echo          The board will run but cannot start AI sessions.
)

:: --- Dependencies ---
echo   [..]   Installing dependencies...
call pnpm install --frozen-lockfile >nul 2>nul || call pnpm install >nul 2>nul
echo   [OK]   Dependencies ready

:: --- Start server (hidden, survives terminal close) ---
echo   [..]   Starting server...
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WindowStyle Hidden -WorkingDirectory '%~dp0'"

:: Wait for PID file (server writes it on listen)
set TRIES=0
:wait_pid
if exist "%PID_FILE%" goto :started
set /a TRIES+=1
if %TRIES% geq 10 goto :start_failed
timeout /t 1 /nobreak >nul
goto :wait_pid

:started
set /p SERVER_PID=<"%PID_FILE%"
echo.
echo   [OK]   Running at http://localhost:%PORT% ^(PID %SERVER_PID%^)
echo   [OK]   Stop with: scripts\stop.bat
echo.
exit /b 0

:start_failed
echo.
echo   [WARN] Server may have failed to start. Check %LOG_FILE%
echo.
exit /b 1
