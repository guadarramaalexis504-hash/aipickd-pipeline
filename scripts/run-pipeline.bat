@echo off
REM =============================================
REM AIPickd — Autonomous Pipeline Runner
REM Called by Windows Task Scheduler every 4 hours
REM =============================================

cd /d "C:\Users\guada\Downloads\Negocio"

REM Create logs directory if it doesn't exist
if not exist "logs" mkdir "logs"

REM Timestamp for log file
for /f "tokens=2 delims==" %%a in ('wmic OS Get localdatetime /value') do set "dt=%%a"
set "timestamp=%dt:~0,4%-%dt:~4,2%-%dt:~6,2%_%dt:~8,2%-%dt:~10,2%"

REM Run the pipeline, log output to dated file
"C:\Program Files\nodejs\node.exe" "C:\Users\guada\Downloads\Negocio\scripts\run-pipeline.js" --gen 1 > "logs\pipeline_%timestamp%.log" 2>&1

REM Keep only the last 30 logs (delete older)
forfiles /P "logs" /M "pipeline_*.log" /D -30 /C "cmd /c del @path" 2>nul

exit /b 0
