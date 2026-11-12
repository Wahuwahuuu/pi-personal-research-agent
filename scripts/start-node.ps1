param([string]$Config)
$project = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $project 'local/node.ts'
if (-not $Config) { $Config = Join-Path $project '.local/node.json' }
$Config=[IO.Path]::GetFullPath($Config)
if (Test-Path -LiteralPath ($Config + '.application.json')) {
    & $nodeExe (Join-Path $project 'scripts/launch-node.ts') --config $Config
    exit $LASTEXITCODE
}
Set-Location -LiteralPath $project
# The scheduled action already uses -WindowStyle Hidden. Keep the node attached
# to this launcher so Task Scheduler observes the real process exit code.
& $nodeExe $entry $config
exit $LASTEXITCODE
