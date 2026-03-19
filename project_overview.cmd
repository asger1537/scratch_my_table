@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM -----------------------------------------------------------------
REM project_overview.cmd - Produce a readable snapshot of this repo
REM   - Focus: Phase 1 docs, schemas, fixtures, and root project files
REM   - Output: YYYY-MM-DD-HHmmss project-overview.txt in the current dir
REM Usage:  project_overview.cmd  ["C:\Path\To\TargetFolder"]
REM         If no argument is provided, this script's folder is used.
REM -----------------------------------------------------------------

if "%~1"=="" (
    set "TARGET=%~dp0"
) else (
    set "TARGET=%~1"
)

for %%I in ("%TARGET%") do set "TARGET=%%~fI"
if not "%TARGET%"=="%SystemDrive%\" if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

if not exist "%TARGET%\." (
    echo Error: "%TARGET%" is not a folder.
    exit /b 1
)

for /f %%A in ('powershell -NoProfile -Command "(Get-Date).ToString(\"yyyy-MM-dd-HHmmss\")"') do set "STAMP=%%A"
set "OUTFILE=%CD%\%STAMP% project-overview.txt"

(
    echo === PROJECT OVERVIEW ===
    echo Target: %TARGET%
    echo Generated: %STAMP%
    echo.
    echo This repository is currently Phase 1 specification work for a local-first tabular transformation tool.
    echo The overview focuses on the docs, schema, fixtures, and root project guidance files.
    echo.
    echo === READ FIRST ===
    call :write_if_exists "AGENTS.md"
    call :write_if_exists "docs\v1-scope.md"
    call :write_if_exists "docs\data-model.md"
    call :write_if_exists "docs\data-semantics.md"
    call :write_if_exists "docs\workflow-ir-v1.md"
    call :write_if_exists "docs\validation-rules.md"
    call :write_if_exists "docs\example-workflows.md"
    call :write_if_exists "schemas\workflow-ir-v1.schema.json"
    echo.
    echo === TOP-LEVEL CONTENTS ===
    call :write_top_level
    echo.
    echo === FOLDER CONTENTS ===
    call :write_dir_listing "docs"
    call :write_dir_listing "schemas"
    call :write_dir_listing "fixtures"
    echo.
    echo === INCLUDED ROOT FILES ===
    call :write_root_files
) > "%OUTFILE%"

call :append_root_files
call :append_dir_files "docs" "*.md"
call :append_dir_files "schemas" "*.json"
call :append_dir_files "fixtures" "*.csv"

echo Done. Created "%OUTFILE%"
exit /b 0

:write_if_exists
if exist "%TARGET%\%~1" echo %~1
goto :eof

:write_top_level
set "FOUND=0"
for /f "delims=" %%F in ('dir /b /on "%TARGET%" 2^>nul') do (
    if /I not "%%F"==".git" (
        set "NAME=%%F"
        set "KEEP=1"
        if /I "!NAME:~-12!"=="snapshot.txt" set "KEEP=0"
        if /I "!NAME:~-20!"=="project-overview.txt" set "KEEP=0"
        if "!KEEP!"=="1" (
            echo %%F
            set "FOUND=1"
        )
    )
)
if "!FOUND!"=="0" echo (none)
goto :eof

:write_dir_listing
set "REL=%~1"
set "DIR=%TARGET%\%~1"
if not exist "%DIR%\." (
    echo --- %REL% ^(missing^) ---
    goto :eof
)

echo --- %REL% ---
set "FOUND=0"
for /f "delims=" %%F in ('dir /b /s /a-d /on "%DIR%\*" 2^>nul') do (
    set "RELFILE=%%F"
    set "RELFILE=!RELFILE:%TARGET%\=!"
    echo !RELFILE!
    set "FOUND=1"
)
if "!FOUND!"=="0" echo (empty)
goto :eof

:write_root_files
set "FOUND=0"
for %%E in (md cmd bat) do (
    for /f "delims=" %%F in ('dir /b /a-d /on "%TARGET%\*.%%E" 2^>nul') do (
        echo %%F
        set "FOUND=1"
    )
)
if "!FOUND!"=="0" echo (none)
goto :eof

:append_root_files
for %%E in (md cmd bat) do (
    for /f "delims=" %%F in ('dir /b /a-d /on "%TARGET%\*.%%E" 2^>nul') do (
        call :append_file "%TARGET%\%%F"
    )
)
goto :eof

:append_dir_files
set "DIR=%TARGET%\%~1"
set "PATTERN=%~2"
if not exist "%DIR%\." goto :eof

for /f "delims=" %%F in ('dir /b /s /a-d /on "%DIR%\%PATTERN%" 2^>nul') do (
    call :append_file "%%F"
)
goto :eof

:append_file
set "FILEPATH=%~f1"
set "RELFILE=!FILEPATH:%TARGET%\=!"

>>"%OUTFILE%" echo.
>>"%OUTFILE%" echo === !RELFILE! ===
type "%~f1" >> "%OUTFILE%"
goto :eof
