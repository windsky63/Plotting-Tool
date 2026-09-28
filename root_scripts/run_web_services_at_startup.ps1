$ErrorActionPreference = 'Stop'

$packageRoot = Split-Path -Parent $PSScriptRoot
$pdfViewerRoot = Join-Path $packageRoot 'pdf_viewer'
$idfToolRoot = Join-Path $packageRoot 'idf_mineru_tool'
$logRoot = Join-Path $pdfViewerRoot 'runtime\startup-logs'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$pythonExe = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'

if (-not (Test-Path -LiteralPath $pythonExe)) {
    throw "Python 3.11 was not found at $pythonExe"
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Test-ListeningPort {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (Test-ListeningPort -Port 3005) {
    throw 'Port 3005 is already occupied before the startup task begins.'
}
if (Test-ListeningPort -Port 3006) {
    throw 'Port 3006 is already occupied before the startup task begins.'
}

$env:HOST = '0.0.0.0'
$env:PORT = '3005'
$env:ENABLE_PDF_PAGE_CACHE = '1'
$env:OCR_TARGET_HOST = '192.168.32.61'
$env:OCR_TARGET_PORT = '8766'
$env:MINERU_TARGET_HOST = '192.168.32.61'
$env:MINERU_TARGET_PORT = '8081'
$env:AUTOSAVE_TARGET_HOST = '127.0.0.1'
$env:AUTOSAVE_TARGET_PORT = '8789'
$env:PDF_PAGE_CACHE_PYTHON = $pythonExe

$production = Start-Process -PassThru -WindowStyle Hidden `
    -FilePath $nodeExe `
    -ArgumentList @((Join-Path $pdfViewerRoot 'scripts\prod_server_with_autosave_proxy.js')) `
    -WorkingDirectory $pdfViewerRoot `
    -RedirectStandardOutput (Join-Path $logRoot 'production-3005.out.log') `
    -RedirectStandardError (Join-Path $logRoot 'production-3005.err.log')

$env:IDF_TOOL_HOST = '0.0.0.0'
$env:IDF_TOOL_PORT = '3006'
$env:OCR_HOST = '192.168.32.61'
$env:OCR_PORT = '8766'
$env:MINERU_HOST = '192.168.32.61'
$env:MINERU_PORT = '8081'
$env:MINERU_CONCURRENCY = '4'

$idfTool = Start-Process -PassThru -WindowStyle Hidden `
    -FilePath $nodeExe `
    -ArgumentList @((Join-Path $idfToolRoot 'server.js')) `
    -WorkingDirectory $idfToolRoot `
    -RedirectStandardOutput (Join-Path $logRoot 'idf-3006.out.log') `
    -RedirectStandardError (Join-Path $logRoot 'idf-3006.err.log')

Start-Sleep -Seconds 2
if ($production.HasExited -or -not (Test-ListeningPort -Port 3005)) {
    if (-not $idfTool.HasExited) { Stop-Process -Id $idfTool.Id -Force }
    throw 'Luotu production service failed to start on port 3005.'
}
if ($idfTool.HasExited -or -not (Test-ListeningPort -Port 3006)) {
    if (-not $production.HasExited) { Stop-Process -Id $production.Id -Force }
    throw 'IDF region tool failed to start on port 3006.'
}

try {
    while (-not $production.HasExited -and -not $idfTool.HasExited) {
        Start-Sleep -Seconds 5
    }
} finally {
    if (-not $production.HasExited) { Stop-Process -Id $production.Id -Force }
    if (-not $idfTool.HasExited) { Stop-Process -Id $idfTool.Id -Force }
}

throw 'A managed Luotu web service exited unexpectedly.'
