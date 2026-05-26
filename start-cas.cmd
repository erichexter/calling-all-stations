@echo off
REM CAS launcher — wraps node so stdout/stderr (including pre-init crashes) hit a log file.
REM server.js writes its own structured log to server.log. This file captures everything
REM the Node runtime itself emits before/around the structured logger.
cd /d C:\calling-all-stations
echo. >> server-stdouterr.log
echo ================================================================ >> server-stdouterr.log
echo %DATE% %TIME% START PID=%RANDOM% >> server-stdouterr.log
echo ================================================================ >> server-stdouterr.log
"C:\Program Files\nodejs\node.exe" server.js >> server-stdouterr.log 2>&1
