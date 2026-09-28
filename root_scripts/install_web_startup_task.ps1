$ErrorActionPreference = 'Stop'

$taskName = 'LuotuRemoteWorkstation'
$runnerPath = Join-Path $PSScriptRoot 'start_remote_workstation.ps1'
$statusPath = Join-Path $PSScriptRoot 'web_startup_task_status.json'

trap {
    [pscustomobject]@{
        ok = $false
        taskName = $taskName
        error = $_.Exception.Message
        checkedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statusPath
    exit 1
}

if (-not (Test-Path -LiteralPath $runnerPath)) {
    throw "Startup runner is missing: $runnerPath"
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts Luotu production 3005, IDF tool 3006, autosave 8789 and support assistant 8788 at Windows startup.' `
    -Force | Out-Null

$registeredTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop

[pscustomobject]@{
    ok = $true
    taskName = $taskName
    runnerPath = $runnerPath
    state = [string]$registeredTask.State
    enabled = [bool]$registeredTask.Settings.Enabled
    userId = $registeredTask.Principal.UserId
    runLevel = [string]$registeredTask.Principal.RunLevel
    trigger = 'AtStartup'
    action = $registeredTask.Actions[0].Execute
    arguments = $registeredTask.Actions[0].Arguments
    checkedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statusPath

Write-Host "Scheduled task installed: $taskName"
