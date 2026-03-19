Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\dev\atomic-authority-agent && node node_modules/tsx/dist/cli.mjs src/scheduler/index.ts", 0, False
