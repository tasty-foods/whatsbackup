' Launches the WhatsApp Media Dashboard with no visible window.
' Node keeps running in the background after this script exits.
Set fso = CreateObject("Scripting.FileSystemObject")
projDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = projDir

' Make sure the logs folder exists.
If Not fso.FolderExists(projDir & "\logs") Then fso.CreateFolder(projDir & "\logs")

' 0 = hidden window, False = don't wait (detach so Node outlives this script).
sh.Run "cmd /c node ""src\index.js"" >> ""logs\dashboard.log"" 2>&1", 0, False
