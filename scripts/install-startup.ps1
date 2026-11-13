param([switch]$Remove,[switch]$NodeOnly,[string]$Config,[switch]$Status)
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$defaultConfig=Join-Path $project '.local\node.json'
if (-not $Config) { $Config=$defaultConfig }
$Config=[IO.Path]::GetFullPath($Config)
if ($Config -match '["\r\n]') { throw 'INVALID_CONFIGURATION_PATH' }
$sha=[Security.Cryptography.SHA256]::Create()
try { $hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Config.ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
finally { $sha.Dispose() }
$isDefault=$Config -eq $defaultConfig
$name=if($isDefault){'Pi Personal Research Agent Local Node'}else{'Pi Personal Research Agent '+$hash.Substring(0,16)}
$description='PRA_CONFIG_SHA256='+$hash
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) {
    $owned=$existing.Description -eq $description
    $userMatches=$false
    try {
        $principalId=[string]$existing.Principal.UserId
        $principalSid=if($principalId -match '^S-1-'){[Security.Principal.SecurityIdentifier]::new($principalId)}else{([Security.Principal.NTAccount]::new($principalId)).Translate([Security.Principal.SecurityIdentifier])}
        $userMatches=$principalSid.Value -eq $identity.User.Value
    } catch { $userMatches=$false }
    $allowed=@()
    foreach($entry in @('start-node.ps1','start-desktop.ps1')){
        $path=Join-Path $PSScriptRoot $entry
        $base='-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$path+'"'
        $allowed+=($base+' -Config "'+$Config+'"')
        if($isDefault){$allowed+=$base}
    }
    $actions=@($existing.Actions)
    $actionMatches=$actions.Count -eq 1 -and ([IO.Path]::GetFileName([string]$actions[0].Execute) -eq 'powershell.exe') -and ($allowed -contains [string]$actions[0].Arguments)
    $legacy=$isDefault -and [string]::IsNullOrEmpty([string]$existing.Description)
    if (-not $userMatches -or -not $actionMatches -or (-not $owned -and -not $legacy)) { throw 'STARTUP_TASK_NOT_OWNED' }
}
if ($Status) { @{registered=[bool]$existing}|ConvertTo-Json -Compress; exit }
if ($Remove) {
    if($existing){Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop}
    Write-Output 'Startup removed for this configuration.'
    exit
}
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'NODE_CONFIGURATION_REQUIRED' }
$script=Join-Path $PSScriptRoot $(if($NodeOnly){'start-node.ps1'}else{'start-desktop.ps1'})
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+$script+'" -Config "'+$Config+'"')
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal=New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $name -Description $description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output 'Startup registered for this configuration. The service has not been started.'
