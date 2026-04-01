Dim WshShell
Set WshShell = CreateObject("WScript.Shell")

' Kill any existing scheduler process before launching to prevent duplicates
WshShell.Run "powershell -Command ""Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*scheduler/index.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }""", 0, True

' Brief pause to let the process fully exit
WScript.Sleep 5000

' Launch the scheduler hidden (windowStyle 0 = hidden, bWaitOnReturn False = async)
' Logging is handled by initLogger() in src/utils/logger.ts — no stdout redirect needed
WshShell.Run "cmd /c cd /d C:\dev\atomic-authority-agent && node node_modules/tsx/dist/cli.mjs src/scheduler/index.ts", 0, False
