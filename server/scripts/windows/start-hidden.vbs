' Starts run-server.cmd with no window. Used by the "BugSnap Server" scheduled task.
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "run-server.cmd")
CreateObject("WScript.Shell").Run "cmd.exe /c """ & script & """", 0, False
