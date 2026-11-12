param([string]$Template, [string]$Config)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $Template) { $Template=Join-Path $project '.local\node-install.json' }
if (-not $Config) { $Config=Join-Path $project '.local\node.json' }
$Template=[IO.Path]::GetFullPath($Template)
$Config=[IO.Path]::GetFullPath($Config)
$nodeExe=(Get-Command node.exe -ErrorAction Stop).Source
$entry=Join-Path $project 'scripts\setup-node.ts'
& $nodeExe $entry --template $Template --config $Config --check | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NODE_PREFLIGHT_FAILED: 请先修复上方资源或配置问题。' }
Write-Output '请在云端网页使用通行密钥登录，在设置的本地设备页生成配对凭证。'
$credential=Read-Host '粘贴设备配对凭证（输入不显示）' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential)
try {
    # Pass only through stdin; never put credentials in process arguments or the saved JSON.
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | & $nodeExe $entry --template $Template --config $Config
    if ($LASTEXITCODE -ne 0) { throw 'NODE_SETUP_FAILED: 未完成配对，请检查凭证及配置。' }
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $credential.Dispose() }
Write-Output '本机配置与加密设备凭证已保存。可启动托盘；服务尚未自动启动。'
