@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "OUT=%ROOT%project-overview.txt"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = [System.IO.Path]::GetFullPath('%ROOT%');" ^
  "$out = [System.IO.Path]::GetFullPath('%OUT%');" ^
  "$includeExtensions = @('.md', '.json', '.html', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.css', '.csv');" ^
  "$rootNames = @('AGENTS.md', 'README.md', 'V1_roadmap.md', 'package.json', 'tsconfig.json', 'index.html', 'vite.config.mjs', 'vitest.config.mjs');" ^
  "$allowedTopDirs = @('docs', 'schemas', 'fixtures', 'src', 'scripts');" ^
  "$excludedPathParts = @('\.git\', '\node_modules\', '\dist\');" ^
  "$excludedNames = @('package-lock.json', 'project_overview.cmd', 'project_overview.bat');" ^
  "$excludedNamePatterns = @('project-overview*.txt', '*snapshot.txt');" ^
  "$files = Get-ChildItem -Path $root -Recurse -File | Where-Object {" ^
  "  $fullName = $_.FullName;" ^
  "  $name = $_.Name;" ^
  "  if ($excludedPathParts | Where-Object { $fullName -like ('*' + $_ + '*') }) { return $false }" ^
  "  if ($excludedNames -contains $name) { return $false }" ^
  "  if ($excludedNamePatterns | Where-Object { $name -like $_ }) { return $false }" ^
  "  $extension = $_.Extension.ToLowerInvariant();" ^
  "  if ($includeExtensions -notcontains $extension) { return $false }" ^
  "  $relativePath = $fullName.Substring($root.Length).TrimStart('\');" ^
  "  if ($rootNames -contains $relativePath) { return $true }" ^
  "  $firstSegment = $relativePath.Split([System.IO.Path]::DirectorySeparatorChar)[0];" ^
  "  return $allowedTopDirs -contains $firstSegment" ^
  "} | Sort-Object { $_.FullName.Substring($root.Length).TrimStart('\') };" ^
  "$lines = [System.Collections.Generic.List[string]]::new();" ^
  "$lines.Add('Project overview');" ^
  "$lines.Add(('Generated: {0}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss K')));" ^
  "$lines.Add('');" ^
  "$lines.Add('Included files');" ^
  "$lines.Add('--------------');" ^
  "foreach ($file in $files) {" ^
  "  $relativePath = $file.FullName.Substring($root.Length).TrimStart('\');" ^
  "  $lines.Add($relativePath);" ^
  "}" ^
  "$lines.Add('');" ^
  "$lines.Add('Concatenated contents');" ^
  "$lines.Add('--------------------');" ^
  "foreach ($file in $files) {" ^
  "  $relativePath = $file.FullName.Substring($root.Length).TrimStart('\');" ^
  "  $lines.Add('');" ^
  "  $lines.Add(('===== {0} =====' -f $relativePath));" ^
  "  $lines.AddRange([string[]](Get-Content -Path $file.FullName));" ^
  "}" ^
  "[System.IO.File]::WriteAllLines($out, $lines);"

if errorlevel 1 exit /b %errorlevel%

echo Overview written to %OUT%
exit /b 0
