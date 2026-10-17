# lsp-relay 데몬을 백그라운드(창 없음)로 시작한다. 이미 떠 있으면 아무것도 하지 않는다.
# 프로젝트는 projects.json 으로 관리하고, pinned 프로젝트는 시작하자마자 미리 로드된다.
# 사용: powershell -ExecutionPolicy Bypass -File start-relay.ps1 [-Install | -Uninstall]
#   -Install   로그인 시 자동 시작을 작업 스케줄러에 등록 (현재 사용자, 관리자 권한 불필요)
#   -Uninstall 그 등록을 해제
param([switch]$Install, [switch]$Uninstall)

$taskName = 'lsp-relay'

if ($Install) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
        -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'lsp-relay 데몬 로그인 자동 시작' -Force | Out-Null
    Write-Output "작업 스케줄러에 '$taskName' 등록 (로그인 시 자동 시작)"
    exit 0
}
if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Output "작업 스케줄러에서 '$taskName' 해제"
    } else {
        Write-Output "'$taskName' 등록이 없다"
    }
    exit 0
}

$port = if ($env:LSP_RELAY_PORT) { $env:LSP_RELAY_PORT } else { 7420 }
try {
    Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 | Out-Null
    Write-Output "lsp-relay 가 이미 실행 중이다 (포트 $port)"
    exit 0
} catch {}

Start-Process -FilePath node -ArgumentList "`"$PSScriptRoot\server.js`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden

for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 200
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
        $names = ($h.projects | ForEach-Object { $_.name + $(if ($_.pinned) { '(고정)' } else { '' }) }) -join ', '
        Write-Output "lsp-relay 시작 (pid $($h.pid), 기본 $($h.default), 프로젝트 $names)"
        exit 0
    } catch {}
}
Write-Output "lsp-relay 가 10초 안에 응답하지 않았다 — relay.log 확인"
exit 1
