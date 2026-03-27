@echo off
setlocal EnableExtensions

cd /d "%~dp0"
call npm run dev %*

exit /b %errorlevel%
