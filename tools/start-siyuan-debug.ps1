# Launch SiYuan with a CDP debug port, so workbuddy can drive plugin debugging.
#
# Run this in YOUR OWN PowerShell (an AI session cannot launch Electron GUI):
#   powershell -ExecutionPolicy Bypass -File E:\HOME\Code\siyuan\siyuan-editor\tools\start-siyuan-debug.ps1
#
# Prerequisite: resources\app\electron\main.js carries the debug patch (checked below).
# The patch is gated by an env var, so normal launches are unaffected.
# Restore main.js when done (backup: main.js.bak-pty2 in the same directory).
#
# NOTE: this file must be UTF-8 *with BOM*, otherwise Windows PowerShell 5.1 reads it
# as GBK and parsing breaks. It is also kept pure ASCII on purpose.

$ErrorActionPreference = "Stop"
$main = "D:\programs\SiYuan\resources\app\electron\main.js"
$siyuan = "D:\programs\SiYuan\SiYuan.exe"

# Self-check: is the patch in place?
if (-not (Select-String -Path $main -Pattern "SY_REMOTE_DEBUG_PORT" -Quiet)) {
    Write-Host "[ERROR] main.js lacks the debug patch; CDP port will not work." -ForegroundColor Red
    Write-Host "Insert after the enable-features line:" -ForegroundColor Yellow
    Write-Host 'if (process.env.SY_REMOTE_DEBUG_PORT) {' -ForegroundColor Yellow
    Write-Host '    app.commandLine.appendSwitch("remote-debugging-port", process.env.SY_REMOTE_DEBUG_PORT);' -ForegroundColor Yellow
    Write-Host '}' -ForegroundColor Yellow
    exit 1
}

# Must fully exit any running SiYuan first: the single-instance lock turns a new
# launch into second-instance, and then the debug port never opens.
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*SiYuan*" })
if ($running.Count -gt 0) {
    Write-Host "[WARN] $($running.Count) SiYuan process(es) still running." -ForegroundColor Yellow
    $ans = Read-Host "Kill them all and continue? (y/N)"
    if ($ans -ne "y") { Write-Host "Cancelled."; exit 0 }
    $running | ForEach-Object { try { $_.Kill() } catch {} }
    Start-Sleep -Seconds 3
    # The kernel process must die too, otherwise the workspace lock survives and
    # the next UI launch quits silently.
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -like "*SiYuan-Kernel*" } |
        ForEach-Object { try { $_.Kill() } catch {} }
    Start-Sleep -Seconds 2
}

$env:SY_REMOTE_DEBUG_PORT = "9222"
Start-Process -FilePath $siyuan -WorkingDirectory "D:\programs\SiYuan"

Write-Host "[Launched] Waiting for CDP on 9222 ..."
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 2
    try {
        $r = (Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -UseBasicParsing -TimeoutSec 2).Content
        Write-Host "[READY] CDP 9222 is up. Debugging can start." -ForegroundColor Green
        Write-Host $r.Substring(0, [Math]::Min(160, $r.Length))
        exit 0
    } catch { }
}
Write-Host "[TIMEOUT] CDP not ready. Check for leftover SiYuan processes." -ForegroundColor Red
exit 1
