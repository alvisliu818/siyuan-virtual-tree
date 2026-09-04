# ============================================================
#  siyuan-file-editor 终端服务一键启动脚本 (PowerShell)
#  用法: 右键 → 使用 PowerShell 运行,或在 PowerShell 中执行:
#        .\start-terminal.ps1
# ============================================================

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# 检查 node 是否可用
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Node.js,请先安装: https://nodejs.org/" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

# 检查依赖是否已安装
if (-not (Test-Path "node_modules")) {
    Write-Host "[初始化] 首次运行,正在安装依赖..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] 依赖安装失败" -ForegroundColor Red
        Write-Host "       Windows 安装 node-pty 可能需要 Visual Studio Build Tools" -ForegroundColor Yellow
        Write-Host "       请参考: https://github.com/microsoft/node-pty#installing" -ForegroundColor Yellow
        Read-Host "按回车键退出"
        exit 1
    }
    Write-Host "[初始化] 依赖安装完成" -ForegroundColor Green
    Write-Host ""
}

# 启动终端服务
Write-Host "正在启动终端服务..." -ForegroundColor Cyan
Write-Host "按 Ctrl+C 可停止服务" -ForegroundColor Gray
Write-Host ""
node terminal-server.js @args
