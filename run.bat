@echo off
REM Local start on Windows. Usage: run.bat [room-password]
cd /d "%~dp0"
if not exist node_modules call npm install
if not "%~1"=="" set ROOM_PASSWORD=%~1
start "" http://localhost:3000
node server.js
