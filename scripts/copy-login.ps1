$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$secret = & (Join-Path $PSScriptRoot 'read-secret.ps1') (Join-Path $PSScriptRoot '../.local/admin.secret')
[Windows.Forms.Clipboard]::SetText($secret)
Write-Output '登录凭证已复制到剪贴板；请粘贴到验证站点的登录框，用后清除剪贴板。'
