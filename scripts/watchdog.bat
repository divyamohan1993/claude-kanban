@echo off
REM ============================================================================
REM Claude Kanban Watchdog — monitors server heartbeat, auto-restarts on crash.
REM Run this in a separate terminal or via Task Scheduler.
REM
REM How it works:
REM   1. Checks .data/.heartbeat every 60 seconds
REM   2. If heartbeat file is stale (>90 seconds old), server is dead
REM   3. Kills orphaned node processes and restarts the server
REM   4. On restart, recoverOrphanedCards() resets stuck cards
REM   5. Recovery poller auto-resumes rate-limited cards when usage resets
REM
REM Usage:
REM   scripts\watchdog.bat            (run in foreground)
REM   start /min scripts\watchdog.bat (run minimized)
REM ============================================================================

setlocal enabledelayedexpansion
set "ROOT=%~dp0\.."
set "HEARTBEAT=%ROOT%.data\.heartbeat"
set "RESTART_MARKER=%ROOT%.data\.restart-requested"
set "WATCHDOG_LOG=%ROOT%.data\watchdog.log"
set "CHECK_INTERVAL=60"
set "STALE_THRESHOLD=90"

echo [%date% %time%] Watchdog started for %ROOT% >> "%WATCHDOG_LOG%"
echo Claude Kanban Watchdog — monitoring server health
echo   Heartbeat: %HEARTBEAT%
echo   Check interval: %CHECK_INTERVAL%s
echo   Stale threshold: %STALE_THRESHOLD%s
echo.

:loop
REM Check if heartbeat file exists
if not exist "%HEARTBEAT%" (
    echo [%date% %time%] No heartbeat file — server may not be running
    echo [%date% %time%] No heartbeat file >> "%WATCHDOG_LOG%"
    goto start_server
)

REM Check heartbeat file age using PowerShell
for /f %%A in ('powershell -NoProfile -Command "(New-TimeSpan -Start (Get-Item '%HEARTBEAT%').LastWriteTime -End (Get-Date)).TotalSeconds"') do set "AGE=%%A"

REM Parse age (PowerShell returns decimal, truncate to integer)
for /f "tokens=1 delims=." %%B in ("!AGE!") do set "AGE_INT=%%B"

if !AGE_INT! GTR %STALE_THRESHOLD% (
    echo [%date% %time%] STALE heartbeat ^(!AGE_INT!s old^) — server crashed or hung
    echo [%date% %time%] STALE heartbeat ^(!AGE_INT!s^) >> "%WATCHDOG_LOG%"
    goto start_server
) else (
    REM Server is alive — check for restart marker
    if exist "%RESTART_MARKER%" (
        echo [%date% %time%] Restart requested by server — restarting
        echo [%date% %time%] Restart requested >> "%WATCHDOG_LOG%"
        del "%RESTART_MARKER%" 2>nul
        goto start_server
    )
)

timeout /t %CHECK_INTERVAL% /nobreak >nul
goto loop

:start_server
echo [%date% %time%] Starting server...
echo [%date% %time%] Starting server >> "%WATCHDOG_LOG%"

REM Kill any orphaned node processes running our server
for /f "tokens=2" %%P in ('wmic process where "CommandLine like '%%server.js%%' and CommandLine like '%%claude%%'" get ProcessId 2^>nul ^| findstr /r "[0-9]"') do (
    echo [%date% %time%] Killing orphaned process %%P
    echo [%date% %time%] Killing PID %%P >> "%WATCHDOG_LOG%"
    taskkill /PID %%P /T /F >nul 2>&1
)

REM Wait for ports to release
timeout /t 3 /nobreak >nul

REM Start server in background
cd /d "%ROOT%"
start /min "Claude Kanban Server" cmd /c "node src/server.js >> .data\server.log 2>&1"

echo [%date% %time%] Server started
echo [%date% %time%] Server started >> "%WATCHDOG_LOG%"

REM Wait for server to initialize before resuming checks
timeout /t 10 /nobreak >nul
goto loop
