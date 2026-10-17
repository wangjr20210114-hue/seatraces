@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
node "%~dp0scripts\ui-test-menu.mjs" %*
set "UI_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %UI_EXIT%
