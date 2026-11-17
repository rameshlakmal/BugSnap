@echo off
rem Keeps the BugSnap server running in the background on Windows.
rem Started hidden at logon by the "BugSnap Server" scheduled task (see install-autostart.ps1).
rem Restarts the server if it stops; output goes to server\data\server.log.
setlocal
cd /d "%~dp0..\.."
if not exist data mkdir data
set "LOG=data\server.log"
set "BS_PORT=4800"
if exist .env for /f "tokens=1,* delims== " %%a in ('findstr /r /b /c:"PORT *=" .env') do set "BS_PORT=%%b"

:loop
rem Keep the log small: start a new one past 5 MB.
if exist "%LOG%" for %%f in ("%LOG%") do if %%~zf GTR 5242880 move /y "%LOG%" "%LOG%.old" >nul
rem Another copy already running (for example started by hand)? Check again in a minute.
netstat -ano -p tcp | findstr /r /c:":%BS_PORT% .*LISTENING" >nul && (
  ping -n 61 127.0.0.1 >nul
  goto loop
)
echo.>>"%LOG%"
echo === %date% %time% starting BugSnap server on port %BS_PORT% ===>>"%LOG%"
node --env-file-if-exists=.env src/index.js >>"%LOG%" 2>&1
echo === %date% %time% server stopped (exit %errorlevel%), restarting in 5 s ===>>"%LOG%"
ping -n 6 127.0.0.1 >nul
goto loop
