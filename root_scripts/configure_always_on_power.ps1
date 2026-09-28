$ErrorActionPreference = 'Stop'

$statusPath = Join-Path $PSScriptRoot 'always_on_power_status.json'
$hybridSleepSetting = '94ac6d29-73ce-41a6-809f-6363ba21b47e'
$unattendedSleepSetting = '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0'

trap {
    [pscustomobject]@{
        ok = $false
        error = $_.Exception.Message
        checkedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statusPath
    exit 1
}

# Keep the existing display-off time. Only sleep and hibernation are changed.
powercfg.exe /change standby-timeout-ac 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable AC automatic sleep.' }
powercfg.exe /change standby-timeout-dc 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable DC automatic sleep.' }
powercfg.exe /change hibernate-timeout-ac 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable AC automatic hibernation.' }
powercfg.exe /change hibernate-timeout-dc 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable DC automatic hibernation.' }

powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_SLEEP $hybridSleepSetting 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable AC hybrid sleep.' }
powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_SLEEP $hybridSleepSetting 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable DC hybrid sleep.' }
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_SLEEP $unattendedSleepSetting 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable AC unattended sleep.' }
powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_SLEEP $unattendedSleepSetting 0
if ($LASTEXITCODE -ne 0) { throw 'Failed to disable DC unattended sleep.' }

powercfg.exe /hibernate off
if ($LASTEXITCODE -ne 0) { throw 'Failed to turn hibernation off.' }
powercfg.exe /setactive SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { throw 'Failed to reactivate the current power scheme.' }

[pscustomobject]@{
    ok = $true
    automaticSleepAcSeconds = 0
    automaticSleepDcSeconds = 0
    automaticHibernateAcSeconds = 0
    automaticHibernateDcSeconds = 0
    hybridSleepEnabled = $false
    hibernationEnabled = $false
    displayTimeoutChanged = $false
    checkedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statusPath

