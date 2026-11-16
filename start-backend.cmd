@echo off
rem Starts the AI MCQ Assistant backend on http://127.0.0.1:3000
rem Double-click this file and keep the window open while you use the extension.
cd /d "%~dp0"
title AI MCQ Assistant backend
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :failed
)
if not exist apps\backend\dist\main.js (
  echo Building...
  call npm run build || goto :failed
)
echo Starting backend. Keep this window open. Close it to stop the backend.
call npm run start:prod --workspace=@ai-mcq/backend
:failed
echo.
echo The backend stopped. Read the message above, then press any key to close.
pause >nul
