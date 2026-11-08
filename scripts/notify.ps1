Add-Type -AssemblyName System.Windows.Forms
$notification = New-Object System.Windows.Forms.NotifyIcon
$notification.Icon = [System.Drawing.SystemIcons]::Information
$notification.Visible = $true
$notification.BalloonTipTitle = 'Personal Research Agent'
$notification.BalloonTipText = '研究任务有更新，请打开站内收件箱查看。'
$notification.ShowBalloonTip(5000)
Start-Sleep -Seconds 6
$notification.Dispose()
