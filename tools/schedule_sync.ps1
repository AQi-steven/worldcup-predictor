# ============================================
# schedule_sync.ps1 - 创建 Windows 计划任务
# 每15分钟运行 run-sync.bat
# 时段：每天 06:00 ~ 23:45（北京时间）
# 有效期：2026-06-21 ~ 2026-07-20
# ============================================

$ErrorActionPreference = "Stop"

$taskName = "世界杯比分自动同步"
$batPath = "REPLACE_WITH_PROJECT_DIR\run-sync.bat"

# 1. 如果已存在同名任务，先删除（无害，触发器和历史都会重置）
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "删除已有任务: $taskName"
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# 2. 定义动作：运行批处理脚本
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$batPath`"" -WorkingDirectory "REPLACE_WITH_PROJECT_DIR"

# 3. 定义触发器：每天 06:00 启动，之后每 15 分钟重复一次，持续 17 小时 45 分钟
#    这样覆盖 06:00 / 06:15 / ... / 23:45
$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At "06:00" `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Hours 17 -Minutes 45)

# 4. 设置：即使笔记本用电池也运行，错过则尽快补上
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

# 5. 注册任务（以当前用户身份运行，不需要管理员密码）
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "世界杯2026比分自动同步 - 每15分钟运行sync-scores.js | 独立于WorkBuddy Token配额" `
    -Force

Write-Host ""
Write-Host "✅ 计划任务已创建成功！"
Write-Host "   任务名称: $taskName"
Write-Host "   执行频率: 每天 06:00-23:45，每15分钟"
Write-Host "   有效期:   2026-06-21 起生效"
Write-Host "   执行脚本: $batPath"
Write-Host ""
Write-Host "💡 手动测试:   schtasks /Run /TN `"$taskName`""
Write-Host "💡 查看状态:   schtasks /Query /TN `"$taskName`" /V /FO LIST"
Write-Host "💡 查看日志:   type REPLACE_WITH_PROJECT_DIR\sync-scheduled.log"
Write-Host "💡 回滚操作:   powershell -File REPLACE_WITH_PROJECT_DIR\rollback_sync.ps1"
Write-Host ""
