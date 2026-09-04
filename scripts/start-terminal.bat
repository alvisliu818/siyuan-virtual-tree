@echo off
chcp 65001 >nul
title siyuan-file-editor 终端服务

REM ============================================================
REM  siyuan-file-editor 终端服务一键启动脚本
REM  双击运行即可,首次运行会自动安装依赖
REM ============================================================

cd /d "%~dp0"

REM 检查 node 是否可用
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js,请先安装: https://nodejs.org/
    pause
    exit /b 1
)

REM 检查依赖是否已安装(node_modules 目录是否存在)
if not exist "node_modules" (
    echo [初始化] 首次运行,正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        echo        Windows 安装 node-pty 可能需要 Visual Studio Build Tools
        echo        请参考: https://github.com/microsoft/node-pty#installing
        pause
        exit /b 1
    )
    echo [初始化] 依赖安装完成
    echo.
)

REM 启动终端服务
echo 正在启动终端服务...
echo 按 Ctrl+C 可停止服务
echo.
node terminal-server.js %*

REM 异常退出时暂停,方便查看错误
if errorlevel 1 (
    echo.
    echo [服务已停止,错误代码: %errorlevel%]
    pause
)
