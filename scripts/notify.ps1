param([long]$Count = 1)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
$notification = New-Object System.Windows.Forms.NotifyIcon
try {
    $notification.Icon = [System.Drawing.SystemIcons]::Information
    $notification.Visible = $true
    $notification.BalloonTipTitle = 'Personal Research Agent'
    $notification.BalloonTipText = if ($Count -gt 1) { "收件箱有 $Count 条新动态，打开后可逐条查看。" } else { '研究任务有更新，请打开站内收件箱查看。' }
    $notification.ShowBalloonTip(5000)
    Start-Sleep -Seconds 6
} finally {
    $notification.Dispose()
}
