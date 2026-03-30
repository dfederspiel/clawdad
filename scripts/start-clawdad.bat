@echo off
REM Start ClawDad Web UI (Windows) and NanoClaw (WSL/Discord+Gmail)
REM Runs at login via Windows Startup folder

REM Start WSL — triggers systemd which auto-starts nanoclaw.service (Discord + Gmail)
start /min "" wsl -d Ubuntu -- sleep infinity

REM Start ClawDad Web UI
cd /d C:\Users\david\code\clawdad-home
start /min "" "C:\Program Files\Git\bin\bash.exe" -c "node dist/index.js >> logs/clawdad.log 2>&1"
