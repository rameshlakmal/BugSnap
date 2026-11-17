@echo off
rem BugSnap setup for Windows: double-click this file. Safe to run again after updates.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\scripts\windows\setup.ps1" %*
echo.
pause
