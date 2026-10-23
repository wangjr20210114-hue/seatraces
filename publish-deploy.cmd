@rem 启动版本发布工具。

@echo off
setlocal
cd /d "%~dp0"
node "%~dp0scripts\publish-deploy.mjs" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Publish or deployment stopped. Read the reason above; do not force push.
if "%~1"=="" pause
exit /b %RESULT%
