@rem 启动腾讯云邮件配置工具。

@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\configure-email.ps1" -Provider tencent_ses
if errorlevel 1 goto failed
echo Configuration saved locally. No email sent and no server restarted.
pause
exit /b 0
:failed
echo Configuration failed. Review the error above.
pause
exit /b 1
