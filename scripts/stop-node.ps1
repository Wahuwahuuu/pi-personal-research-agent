param([string]$Config)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$defaultConfig = Join-Path $project '.local\node.json'
if (-not $Config) { $Config = $defaultConfig }
$Config = [IO.Path]::GetFullPath($Config)
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $project 'local\stop-node.ts'
# The authenticated helper waits for this configuration's node and tray.
# Never stop unrelated Node/Python processes or another configuration's startup task.
& $nodeExe $entry $Config
if ($LASTEXITCODE -ne 0) { throw 'LOCAL_STOP_FAILED: 本机服务尚未确认停止，请查看节点状态。' }
if ($Config -eq $defaultConfig) {
    Stop-ScheduledTask -TaskName 'Pi Personal Research Agent Local Node' -ErrorAction SilentlyContinue
}
Write-Output '本项目本地节点与托盘已停止；云端任务仍可访问。下次登录或手动启动会恢复服务。'
