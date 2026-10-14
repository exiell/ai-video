<#
  AniGuide 一键启动器（Windows · 真正的逻辑在这里）

  ===========================================================================
  为什么逻辑写在 PowerShell 里，而不是直接写批处理
  ===========================================================================
  一开始我用纯 .cmd 写，结果踩了一个很隐蔽的坑：

    **cmd 是按系统代码页逐字节解析 .cmd 文件的。**
    中文 Windows 的代码页是 936(GBK)，而文件是 UTF-8 ——
    里面的中文被按 GBK 误读，产生的乱码字节会破坏后续行的解析，
    表现为「明明对的命令报语法错误」「一个好好的 Node v24 被判成版本太低」。

  这类问题极难排查，因为它取决于用户的系统区域设置。
  所以改成：**start.cmd 只放 ASCII（保持引导作用），全部逻辑用 PowerShell。**
  PowerShell 原生按 UTF-8 读脚本，中文不会有任何问题。

  ===========================================================================
  它做什么
  ===========================================================================
  换一台电脑要准备的东西有好几步，而每一步失败时的报错都不是人话
  （ERR_PNPM_IGNORED_BUILDS、EBUSY、corepack 未启用……）。
  这个脚本把四种情况都处理掉，并且**失败时说清是哪一步、该怎么办**。
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Write-Banner {
  Write-Host ''
  Write-Host '  ============================================' -ForegroundColor Cyan
  Write-Host '    AniGuide · AI 动漫视频创作向导' -ForegroundColor Cyan
  Write-Host '  ============================================' -ForegroundColor Cyan
  Write-Host ''
}

function Fail($title, $lines) {
  Write-Host ''
  Write-Host "  [X] $title" -ForegroundColor Red
  Write-Host ''
  foreach ($l in $lines) { Write-Host "      $l" }
  Write-Host ''
  Read-Host '  按回车键关闭'
  exit 1
}

function Step($n, $text) {
  Write-Host "  [$n/4] $text" -ForegroundColor Green
}

Write-Banner

# ---------------------------------------------------------------------------
# 第 1 步：找 Node.js
# ---------------------------------------------------------------------------
# 很多人把 Node 装在 D 盘或别的盘，不一定在 PATH 里，所以主动多找几个位置。
$nodeCandidates = @()
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $nodeCandidates += $cmd.Source }
$nodeCandidates += @(
  "$env:ProgramFiles\nodejs\node.exe"
  "${env:ProgramFiles(x86)}\nodejs\node.exe"
  'D:\Program Files\nodejs\node.exe'
  'D:\nodejs\node.exe'
  "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
)
$nodeExe = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $nodeExe) {
  Fail '没有找到 Node.js' @(
    '这个工具需要 Node.js 20 或更高版本才能运行。',
    '',
    '请去这里下载安装（选 LTS 版本，一路下一步即可）：',
    '  https://nodejs.org/zh-cn',
    '',
    '装完之后关掉这个窗口，再双击一次 start.cmd 就能继续。'
  )
}

$nodeVer = (& $nodeExe --version) -replace '^v', ''
$nodeMajor = [int]($nodeVer -split '\.')[0]

if ($nodeMajor -lt 20) {
  Fail "Node.js 版本太低（当前 v$nodeVer，需要 20 或更高）" @(
    '请去 https://nodejs.org/zh-cn 装最新 LTS 版本。',
    '装新版会覆盖旧版，装完关掉窗口再双击一次 start.cmd。'
  )
}
Step 1 "Node.js v$nodeVer"

# ---------------------------------------------------------------------------
# 第 2 步：找 pnpm
# ---------------------------------------------------------------------------
# 优先用 Node 自带的 corepack 启用（版本最稳），不行再退回 npm 全局安装。
function Resolve-Pnpm {
  $c = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  # pnpm 也可能装在 npm 的全局前缀里但没进 PATH
  foreach ($p in @("$env:APPDATA\npm\pnpm.cmd", "$env:LOCALAPPDATA\pnpm\pnpm.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$pnpm = Resolve-Pnpm

if (-not $pnpm) {
  Write-Host '  [2/4] 没有 pnpm，正在自动安装...' -ForegroundColor Yellow

  $nodeDir = Split-Path -Parent $nodeExe
  $corepack = Join-Path $nodeDir 'corepack.cmd'
  if (Test-Path $corepack) {
    & $corepack enable 2>&1 | Out-Null
    & $corepack prepare pnpm@latest --activate 2>&1 | Out-Null
    # corepack 会把 shim 放到 Node 目录，刷新一下 PATH 再找
    $env:PATH = "$nodeDir;$env:PATH"
    $pnpm = Resolve-Pnpm
  }

  if (-not $pnpm) {
    $npm = Join-Path $nodeDir 'npm.cmd'
    if (Test-Path $npm) {
      Write-Host '         改用 npm 安装...' -ForegroundColor Yellow
      & $npm install -g pnpm 2>&1 | Out-Null
      $pnpm = Resolve-Pnpm
    }
  }

  if (-not $pnpm) {
    Fail 'pnpm 自动安装失败' @(
      '请手动打开一个新的命令行窗口，执行：',
      '  npm install -g pnpm',
      '',
      '然后关掉这个窗口再双击一次 start.cmd。'
    )
  }
}

$pnpmVer = (& $pnpm --version) 2>&1 | Select-Object -First 1
Step 2 "pnpm $pnpmVer"

# ---------------------------------------------------------------------------
# 第 3 步：装依赖
# ---------------------------------------------------------------------------
# 用标记文件记录「上次装依赖时 lockfile 的哈希」，只有它变了才重装。
# 否则每次启动都白等一分钟。
$stampFile = Join-Path $root 'node_modules\.aniguide-install-stamp'
$lockFile = Join-Path $root 'pnpm-lock.yaml'
$lockHash = (Get-FileHash $lockFile -Algorithm MD5).Hash

$needInstall = $true
if ((Test-Path (Join-Path $root 'node_modules')) -and (Test-Path $stampFile)) {
  $old = (Get-Content $stampFile -Raw -ErrorAction SilentlyContinue)
  if ($old -and $old.Trim() -eq $lockHash) { $needInstall = $false }
}

if ($needInstall) {
  Step 3 '正在安装依赖（第一次大约需要 1 分钟）...'
  Write-Host ''
  & $pnpm install
  if ($LASTEXITCODE -ne 0) {
    Fail '依赖安装失败' @(
      '常见原因与做法：',
      '  · 网络不通 —— 检查网络，或换一个 npm 镜像源',
      '  · 磁盘空间不足 —— 依赖大约占 120 MB',
      '  · 报错里有 ERR_PNPM_IGNORED_BUILDS',
      '    说明 pnpm-workspace.yaml 被改动了，恢复它即可',
      '',
      '原始报错就在上面，可以截图反馈。'
    )
  }
  # 重算一次：install 有可能更新 lockfile
  $lockHash = (Get-FileHash $lockFile -Algorithm MD5).Hash
  Set-Content -Path $stampFile -Value $lockHash -NoNewline -Encoding ascii
  Write-Host ''
  Write-Host '        依赖安装完成' -ForegroundColor Green
} else {
  Step 3 '依赖已是最新，跳过安装'
}

# ---------------------------------------------------------------------------
# 第 4 步：自检 + 启动
# ---------------------------------------------------------------------------

# 端口被占用说明可能已经开着一个了，避免起两个打架
$busy = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host ''
  Write-Host '  [!] 端口 5173 已被占用 —— 可能已经开着一个了' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '      如果是别的程序占用了这个端口，先关掉它再运行本脚本。'
  Write-Host ''
  $ans = Read-Host '      现在打开 http://localhost:5173/ 看看？(Y/N)'
  if ($ans -match '^[Yy]') { Start-Process 'http://localhost:5173/' }
  Write-Host ''
  Read-Host '  按回车键关闭'
  exit 0
}

# 同步盘会让 Vite 的文件监视器因文件锁崩掉（EBUSY）。
# 不阻止用户，但必须提醒——否则崩了会以为是代码问题。
if ($root -match 'OneDrive|Dropbox|Nutstore|坚果云|百度网盘|Google Drive') {
  Write-Host ''
  Write-Host '  [!] 提醒：这个项目在同步盘目录下' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '      保存文件时同步软件会生成临时文件，可能让开发服务器崩溃（报 EBUSY）。'
  Write-Host '      vite.config.ts 里已经做了忽略处理，但如果频繁崩，'
  Write-Host '      建议把项目移到普通目录，例如 D:\code\aniguide'
  Write-Host ''
}

Step 4 '启动开发服务器...'
Write-Host ''
Write-Host '  ------------------------------------------------' -ForegroundColor DarkGray
Write-Host '    就绪后浏览器会自动打开' -ForegroundColor DarkGray
Write-Host '    要停止服务器：在这个窗口按 Ctrl+C，或直接关掉窗口' -ForegroundColor DarkGray
Write-Host '  ------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

# 等端口起来再开浏览器，开太早会看到「无法访问」。
# 用后台任务轮询端口，比固定 sleep 更可靠（慢机器上 6 秒可能不够）。
$opener = Start-Job -ScriptBlock {
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $c = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if ($c) { Start-Process 'http://localhost:5173/'; break }
  }
} -ErrorAction SilentlyContinue

try {
  & $pnpm dev
} finally {
  if ($opener) {
    Stop-Job $opener -ErrorAction SilentlyContinue
    Remove-Job $opener -Force -ErrorAction SilentlyContinue
  }
  Write-Host ''
  Write-Host '  开发服务器已停止。' -ForegroundColor DarkGray
  Write-Host ''
  Read-Host '  按回车键关闭'
}
