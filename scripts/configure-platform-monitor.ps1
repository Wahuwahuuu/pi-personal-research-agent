param(
 [Parameter(Mandatory=$true)][string]$DeploymentRecord,
 [Parameter(Mandatory=$true)][string]$SessionSecret
)
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $project
Write-Host '仅输入本账户 Account Analytics Read 和 Workers Scripts Read 的专用 Token。不要输入部署凭证或模型密钥。'
$metricsSecret=Read-Host 'Cloudflare 只读统计 Token（输入不显示）' -AsSecureString
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($metricsSecret)
try {
 $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 $start=New-Object Diagnostics.ProcessStartInfo
 $start.FileName=(Get-Command node).Source
 $start.WorkingDirectory=$project
 $start.UseShellExecute=$false
 $start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true
 $quote={param([string]$value) if($value.IndexOfAny([char[]]@([char]34,[char]13,[char]10)) -ge 0){throw 'INVALID_PATH'}; '"'+$value+'"' }
 $start.Arguments='scripts/configure-platform-monitor.ts '+(& $quote $DeploymentRecord)+' '+(& $quote $SessionSecret)
 $process=[Diagnostics.Process]::Start($start)
 $process.StandardInput.Write($plain)
 $process.StandardInput.Close()
 $plain=$null
 $process.WaitForExit()
 if($process.ExitCode -ne 0){throw '统计凭证配置未完成，请查看上方脱敏错误。'}
} finally {
 [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
 $metricsSecret.Dispose()
 $plain=$null
}
