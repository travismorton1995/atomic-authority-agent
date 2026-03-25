Dim WshShell
Set WshShell = CreateObject("WScript.Shell")

' Kill any existing scheduler process before launching to prevent duplicates
WshShell.Run "powershell -Command ""Get-WmiObject Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*scheduler/index.ts*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }""", 0, True

' Brief pause to let the process fully exit
WScript.Sleep 5000

' Launch the scheduler hidden (windowStyle 0 = hidden, bWaitOnReturn False = async)
' Output is appended to scheduler.log for diagnostics
WshShell.Run "cmd /c cd /d C:\dev\atomic-authority-agent && node node_modules/tsx/dist/cli.mjs src/scheduler/index.ts >> scheduler.log 2>&1", 0, False
