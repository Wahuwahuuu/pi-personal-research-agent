param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())
try {
 $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
 [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($encrypted))
} finally { [Array]::Clear($bytes, 0, $bytes.Length) }
