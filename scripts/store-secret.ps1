param([string]$Path = "$PSScriptRoot/../.local/device.secret")
$secret = Read-Host '粘贴网页配对得到的设备凭证' -AsSecureString
New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
Add-Type -AssemblyName System.Security
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
 $bytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
 $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllText([IO.Path]::GetFullPath($Path), [Convert]::ToBase64String($encrypted))
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) } }
Write-Output '设备凭证已使用当前 Windows 用户的 DPAPI 加密。'
