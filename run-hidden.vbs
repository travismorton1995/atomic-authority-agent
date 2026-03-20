Dim WshShell, oWMI, oProcesses, oProcess
Set WshShell = CreateObject("WScript.Shell")
Set oWMI = GetObject("winmgmts:\\.\root\cimv2")

' Kill any existing scheduler process before launching to prevent duplicates
Set oProcesses = oWMI.ExecQuery("SELECT * FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%scheduler/index.ts%'")
For Each oProcess In oProcesses
  oProcess.Terminate()
Next

' Brief pause to let the process fully exit
WScript.Sleep 500

' Launch the scheduler hidden (windowStyle 0 = hidden, bWaitOnReturn False = async)
WshShell.Run "cmd /c cd /d C:\dev\atomic-authority-agent && node node_modules/tsx/dist/cli.mjs src/scheduler/index.ts", 0, False
