@echo off
echo Stopping scheduler...
powershell -Command "$proc = Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*scheduler/index.ts*' }; if ($proc) { Stop-Process -Id $proc.ProcessId -Force; Write-Host 'Scheduler stopped (PID' $proc.ProcessId').' } else { Write-Host 'Scheduler was not running.' }"
timeout /t 1 /nobreak >nul
echo Relaunching scheduler...
wscript "C:\dev\atomic-authority-agent\run-hidden.vbs"
echo Scheduler relaunched in background.
