@echo off
setlocal EnableExtensions

cd /d "%~dp0"
call corepack pnpm dev %*

exit /b %errorlevel%
