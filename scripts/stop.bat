@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0\.."

set PID_FILE=.data\server.pid

echo.
echo   Claude Kanban - Stop
echo.

if not exist "%PID_FILE%" (
  echo   [FAIL] No server running ^(no PID file^)
  echo.
  exit /b 1
)

set /p PID=<"%PID_FILE%"
if "%PID%"=="" (
  del /f "%PID_FILE%" >nul 2>nul
  echo   [FAIL] Invalid PID file
  echo.
  exit /b 1
)

tasklist /fi "PID eq %PID%" 2>nul | find "node" >nul 2>nul
if %errorlevel% equ 0 (
  taskkill /PID %PID% /T /F >nul 2>nul
  del /f "%PID_FILE%" >nul 2>nul
  echo   [OK]   Server stopped ^(PID %PID%^)
) else (
  del /f "%PID_FILE%" >nul 2>nul
  echo   [OK]   Server was not running ^(stale PID file cleaned up^)
)
echo.
