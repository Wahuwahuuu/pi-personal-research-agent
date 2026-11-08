$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$entry = Join-Path $project 'local\node.ts'
$config = Join-Path $project '.local\node.json'
Stop-ScheduledTask -TaskName 'Pi Personal Research Agent Local Node' -ErrorAction SilentlyContinue
# Stop only node.exe instances with both this exact entry and this exact config.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
 $_.CommandLine.Contains(('"' + $entry + '"')) -and $_.CommandLine.Contains(('"' + $config + '"'))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Write-Output '本项目本地节点已停止；云端任务仍可访问。'
