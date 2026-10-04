@echo off
REM === 世界杯比分自动同步 ===
REM 由 Windows 计划任务每15分钟触发
REM 独立于 WorkBuddy，不受 Token 配额限制
REM =============================

set "WORK_DIR=REPLACE_WITH_PROJECT_DIR"
set "NODE_EXE=node"
set "LOG_FILE=%WORK_DIR%\sync-scheduled.log"

cd /d "%WORK_DIR%"

echo [%date% %time%] run-sync.bat START >> "%LOG_FILE%"
"%NODE_EXE%" sync-scores.js >> "%LOG_FILE%" 2>&1
echo [%date% %time%] run-sync.bat END (exit=%ERRORLEVEL%) >> "%LOG_FILE%"

exit /b 0
