# Makes the BugSnap server start automatically (hidden) when you log in to Windows.
#   powershell -ExecutionPolicy Bypass -File server\scripts\windows\install-autostart.ps1
# Remove it again with:  -Uninstall

param([switch]$Uninstall, [switch]$Restart)

$taskName = 'BugSnap Server'

if ($Restart) {
  # Stop the server; run-server.cmd starts it again (with the latest code) in about 5 seconds.
  $loops = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run-server.cmd*' }
  if (-not $loops) { Start-ScheduledTask -TaskName $taskName; Write-Output 'BugSnap server started.'; return }
  foreach ($l in $loops) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($l.ProcessId) AND Name='node.exe'" |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  }
  Write-Output 'BugSnap server restarting (back in about 5 seconds).'
  return
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  # Stop the background loop and the server it started (only that one, not other node apps).
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*run-server.cmd*' } |
    ForEach-Object {
      $loopId = $_.ProcessId
      Stop-Process -Id $loopId -Force
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$loopId" |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
  Write-Output 'BugSnap auto-start removed and the background server stopped.'
  return
}

$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description 'Runs the BugSnap server in the background.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Installed. BugSnap now starts when you log in (task '$taskName'). Started it now too."
