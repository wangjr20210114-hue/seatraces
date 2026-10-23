@rem 启动本地开发环境配置与运行脚本。

@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-local.ps1" %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Local development could not start. See the message above.
if "%~1"=="" pause
exit /b %RESULT%
