param([switch]$Show, [string]$Config)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $Config) { $Config=Join-Path $project '.local\node.json' }
$Config=[IO.Path]::GetFullPath($Config)
if (-not (Test-Path -LiteralPath $Config)) { throw 'NODE_CONFIGURATION_REQUIRED: 请先完成本机安装与配对。' }
$configured=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
$python=[string]$configured.libraryPython
if (-not $python) { $python=[string]$configured.python.executable }
if ($python) { $python=Join-Path (Split-Path -Parent $python) 'pythonw.exe' }
else { $python=Join-Path $project '.local\python\Scripts\pythonw.exe' }
if (-not (Test-Path -LiteralPath $python)) { throw 'DESKTOP_RUNTIME_REQUIRED: 请先安装本机 Python 桌面运行环境。' }
$entry=Join-Path $project 'local\desktop\main.py'
Set-Location -LiteralPath $project
# pythonw has no console. --show is an explicit interactive launch; scheduled runs remain in the tray.
$arguments=@($entry,'--config',$Config)
if ($Show) { $arguments+='--show' }
& $python @arguments | Out-Null
exit $LASTEXITCODE
