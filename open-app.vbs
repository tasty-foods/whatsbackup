' Desktop launcher: makes sure the background service is running, then opens
' the dashboard in its own app window (Chrome app mode). One click does it all.
Set fso = CreateObject("Scripting.FileSystemObject")
proj = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")

' Read the configured port from data\settings.json (fallback 8788).
port = "8788"
settingsPath = proj & "\data\settings.json"
If fso.FileExists(settingsPath) Then
  txt = fso.OpenTextFile(settingsPath, 1).ReadAll
  Set re = New RegExp
  re.Pattern = """port""\s*:\s*(\d+)"
  Set m = re.Execute(txt)
  If m.Count > 0 Then port = m(0).SubMatches(0)
End If
base = "http://localhost:" & port

Function IsUp(u)
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.open "GET", u & "/healthz", False
  http.send
  IsUp = (Err.Number = 0 And http.status = 200)
  On Error Goto 0
End Function

If Not IsUp(base) Then
  sh.Run "wscript """ & proj & "\launch-hidden.vbs""", 0, False
  Dim i
  For i = 1 To 60           ' wait up to ~30s for the service to boot
    WScript.Sleep 500
    If IsUp(base) Then Exit For
  Next
End If

' Find Chrome across common install locations; fall back to the default browser.
chromePaths = Array( _
  "C:\Program Files\Google\Chrome\Application\chrome.exe", _
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe")
chrome = ""
For Each cp In chromePaths
  If chrome = "" And fso.FileExists(cp) Then chrome = cp
Next

If chrome <> "" Then
  sh.Run """" & chrome & """ --app=" & base & " --window-size=1200,860", 1, False
Else
  sh.Run base, 1, False
End If
