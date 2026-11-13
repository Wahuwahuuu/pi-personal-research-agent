param([string]$Config,[string]$Runtime,[string]$Release)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $Config) { $Config=Join-Path $project '.local/node.json' }
$arguments=@((Join-Path $project 'scripts/setup-desktop.ts'),'--config',[IO.Path]::GetFullPath($Config))
if ($Runtime) { $arguments+=@('--runtime',[IO.Path]::GetFullPath($Runtime)) }
if ($Release) { $arguments+=@('--release',[IO.Path]::GetFullPath($Release)) }
& node.exe @arguments
exit $LASTEXITCODE
