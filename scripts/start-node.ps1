$project = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $project 'local/node.ts'
$config = Join-Path $project '.local/node.json'
Set-Location -LiteralPath $project
# The scheduled action already uses -WindowStyle Hidden. Keep the node attached
# to this launcher so Task Scheduler observes the real process exit code.
& $nodeExe $entry $config
exit $LASTEXITCODE
