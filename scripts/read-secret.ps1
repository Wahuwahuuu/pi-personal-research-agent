param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($Path).Trim())
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) }
finally { [Array]::Clear($bytes, 0, $bytes.Length) }
