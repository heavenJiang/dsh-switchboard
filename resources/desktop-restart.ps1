param(
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$DesktopPid,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$BackendPid,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [Parameter(Mandatory=$true)][string]$ControlPath,
  [Parameter(Mandatory=$true)][guid]$RequestId,
  [switch]$Worker
)
$ErrorActionPreference = 'Stop'
if (-not $Worker) {
  # Launch via Windows, with no inherited console pipes. This worker outlives
  # both this short launcher and the DSH backend that invoked it.
  $arguments = @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Worker','-DesktopPid',[string]$DesktopPid,'-BackendPid',[string]$BackendPid,'-Executable',('"'+$Executable+'"'),'-LogPath',('"'+$LogPath+'"'),'-ReadyPath',('"'+$ReadyPath+'"'),'-ControlPath',('"'+$ControlPath+'"'),'-RequestId',[string]$RequestId)
  $launched = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Write-Output $launched.Id
  exit 0
}
$startedAt = (Get-Date).ToString('o')
$report = [ordered]@{status='preparing';startedAt=$startedAt;desktopPid=$DesktopPid;backendPid=$BackendPid;requestId=[string]$RequestId;workerPid=$PID}
function Write-Report {
  param([string]$Status)
  $report.status = $Status
  $report.updatedAt = (Get-Date).ToString('o')
  [IO.File]::WriteAllText($LogPath, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
function Get-Identity {
  param([int]$TargetPid)
  Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $TargetPid)
}
function Test-SameProcess {
  param($Original)
  $current = Get-Identity ([int]$Original.ProcessId)
  return $null -ne $current -and $current.CreationDate -eq $Original.CreationDate -and $current.ExecutablePath -eq $Original.ExecutablePath
}
try {
  $Executable = (Resolve-Path -LiteralPath $Executable).ProviderPath
  if ([IO.Path]::GetFileName($Executable) -ne 'DeepSeek Harness.exe') { throw 'Expected the DSH desktop executable' }
  if (-not [IO.Path]::IsPathRooted($LogPath)) { throw 'Restart log must use an absolute path' }
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($LogPath))
  $desktop = Get-Identity $DesktopPid
  $backend = Get-Identity $BackendPid
  if ($null -eq $desktop -or $null -eq $backend -or $desktop.ExecutablePath -ne $Executable -or $backend.ExecutablePath -ne $Executable -or $backend.ParentProcessId -ne $DesktopPid) { throw 'Desktop/backend process identity mismatch' }
  if ($desktop.CommandLine -match '--type=|--expose-internals' -or $backend.CommandLine -notmatch 'dsh-desktop-host[\\/]lib[\\/]index\.js') { throw 'Expected the desktop main process and its DSH backend' }
  Write-Report 'ready'
  [IO.File]::WriteAllText($ReadyPath, [string]$RequestId, [Text.UTF8Encoding]::new($false))
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath $ControlPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $ControlPath) -or [IO.File]::ReadAllText($ControlPath) -ne 'restart') { Write-Report 'cancelled'; exit 0 }
  if (-not (Test-SameProcess $desktop) -or -not (Test-SameProcess $backend)) { throw 'Desktop changed before restart; no process was stopped' }
  $processes = @(Get-CimInstance Win32_Process)
  $owned = [Collections.Generic.HashSet[int]]::new()
  [void]$owned.Add($DesktopPid)
  do {
    $added = $false
    foreach ($item in $processes) {
      if ($item.ProcessId -ne $PID -and $owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $added = $true }
    }
  } while ($added)
  $originals = @($processes | Where-Object { $owned.Contains([int]$_.ProcessId) })
  if (-not $owned.Contains($BackendPid)) { throw 'Backend no longer belongs to the desktop' }
  $report.ownedProcessCount = $originals.Count
  Write-Report 'stopping'
  # Main-process exit disconnects native IPC; the backend then runs its own shutdown.
  Stop-Process -Id $DesktopPid -Force
  Wait-Process -Id $BackendPid -Timeout 20 -ErrorAction SilentlyContinue
  foreach ($item in $originals) {
    if (Test-SameProcess $item) { Stop-Process -Id $item.ProcessId -Force }
  }
  Wait-Process -Id @($originals.ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
  if (@($originals | Where-Object { Test-SameProcess $_ }).Count -ne 0) { throw 'An old DSH process did not stop; relaunch was not attempted' }
  foreach ($key in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_CHANNEL_FD','NODE_UNIQUE_ID')) {
    [Environment]::SetEnvironmentVariable($key, $null, 'Process')
  }
  # A manual launch during the restart interval must not create a second desktop.
  $newMain = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Executable -and $_.CommandLine -notmatch '--type=|--expose-internals' })
  if ($newMain.Count -eq 0) {
    $launched = Start-Process -FilePath $Executable -WorkingDirectory ([IO.Path]::GetDirectoryName($Executable)) -WindowStyle Hidden -PassThru
    $report.newDesktopPid = $launched.Id
    Write-Report 'launched'
  } else {
    $report.newDesktopPid = $newMain[0].ProcessId
    Write-Report 'already-started'
  }
} catch {
  $report.error = $_.Exception.Message
  try { Write-Report 'failed' } catch {}
  exit 1
} finally {
  Remove-Item -LiteralPath $ReadyPath,$ControlPath,($ControlPath+'.tmp') -ErrorAction SilentlyContinue
}
