# sync-pages.ps1 —— 一键同步前端到 GitHub Pages
# 用法：在项目根目录运行 .\sync-pages.ps1
$src = $PSScriptRoot
$tmp = "$env:TEMP\tuantuan-pages-sync"
$env:GIT_SSH_COMMAND = '"C:/Program Files/Git/usr/bin/ssh.exe" -i C:/Users/kathe/.ssh/id_ed25519_tuantuan -o StrictHostKeyChecking=accept-new'

Write-Host "Syncing frontend to tuantuan-app.github.io ..." -ForegroundColor Green

# 克隆现有 pages 仓库（保留历史，避免冲突）
if (Test-Path "$tmp\.git") {
  Set-Location $tmp
  git pull origin main 2>&1 | Out-Null
} else {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  git clone git@github-tuantuan:tuantuan-app/tuantuan-app.github.io.git $tmp 2>&1 | Out-Null
}

# 复制前端文件（仅生产文件，不含测试/示例）
Copy-Item "$src\index.html","$src\merchant.html","$src\admin.html","$src\privacy.html","$src\terms.html" $tmp -Force
Copy-Item "$src\styles.css","$src\styles-crm.css","$src\manifest.webmanifest","$src\sw.js" $tmp -Force
Copy-Item "$src\js\config.js","$src\js\api.js","$src\js\store.js","$src\js\student.js","$src\js\main.js","$src\js\merchant.js","$src\js\merchant-crm.js","$src\js\merchant-ringer.js","$src\js\notify.js","$src\js\console.js","$src\js\contact.js","$src\js\admin.js" "$tmp\js" -Force
Copy-Item "$src\vendor\vue.global.prod.js" "$tmp\vendor" -Force

# 确保不泄露测试/示例文件
Remove-Item "$tmp\js\config.example.js","$tmp\js\admin-test.js" -ErrorAction SilentlyContinue

# 提交并推送
Set-Location $tmp
git config user.name "tuantuan-app"
git config user.email "nihaotuantuan@gmail.com"
git add -A
$ts = Get-Date -Format "yyyyMMdd-HHmm"
git commit -m "deploy: $ts" 2>&1 | Out-Null
git push origin main 2>&1

Set-Location $src
Write-Host "Done! https://tuantuan-app.github.io" -ForegroundColor Green
