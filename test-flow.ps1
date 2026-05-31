[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ApiUrl = "https://script.google.com/macros/s/AKfycbx60aAS2rsAP8oJ958GWi0gfmQ2lw5anEBYAEJJK8DU4hjICzDLHZzlpe2DX3df-fQd-A/exec"

function PostApi($payload) {
  $body = $payload | ConvertTo-Json -Compress -Depth 10
  return Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "text/plain;charset=utf-8" -Body $body -TimeoutSec 30
}

# 1x1 PNG data URL -- minimal valid image for screenshot upload
$tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

$orderId = "#TST-" + (Get-Date -Format "MMddHHmmss")

$placeBody = @{
  action = "placeOrder"
  order = @{
    orderId = $orderId
    vendorId = "shop1"
    HubID = "utm"
    customerName = "Auto-Test-Bot"
    phone = "0199999991"
    building = "A-Block"
    room = "T01"
    items = @(@{ id = "a1"; name = "TestItem-a1"; price = 9.5; qty = 1; options = "" })
    subtotal = 9.5
    packagingFee = 0
    deliveryFee = 1
    total = 10.5
    deliveryMode = "flexible"
    deliveryTime = "Approx 20-30 min"
    remark = "isTest auto-test stage verify"
    isTest = $true
    status = "pending"
  }
}

Write-Host "=== STAGE 1: placeOrder (text-only, 1st phase) ===" -ForegroundColor Cyan
$t0 = [DateTime]::UtcNow
$r1 = PostApi $placeBody
$t1 = [DateTime]::UtcNow
$placeMs = [int]($t1-$t0).TotalMilliseconds
"  ok={0}  orderId={1}  duplicate={2}  RTT={3}ms" -f $r1.ok, $r1.orderId, $r1.duplicate, $placeMs
if (-not $r1.ok) { Write-Host ("FAILED: " + $r1.error) -ForegroundColor Red; exit 1 }

Write-Host "`n=== STAGE 2: attachScreenshot (2nd phase, background upload) ===" -ForegroundColor Cyan
$attachBody = @{ action = "attachScreenshot"; orderId = $r1.orderId; screenshot = $tinyPng }
$t2 = [DateTime]::UtcNow
$r2 = PostApi $attachBody
$t3 = [DateTime]::UtcNow
$attachMs = [int]($t3-$t2).TotalMilliseconds
"  ok={0}  RTT={1}ms" -f $r2.ok, $attachMs
"  screenshotUrl: $($r2.screenshotUrl)"

Write-Host "`n=== STAGE 3: getOrder x5  -- customer-poll baseline RTT ===" -ForegroundColor Cyan
$samples = @()
for ($i = 1; $i -le 5; $i++) {
  Start-Sleep -Milliseconds 1200
  $tA = [DateTime]::UtcNow
  $rg = PostApi @{action="getOrder"; orderId=$r1.orderId}
  $tB = [DateTime]::UtcNow
  $rtt = [int]($tB-$tA).TotalMilliseconds
  $samples += $rtt
  "  call#{0}: status={1}  pollIntervalMs={2}  RTT={3}ms" -f $i, $rg.order.status, $rg.pollIntervalMs, $rtt
}

$avg = [int]($samples | Measure-Object -Average).Average
$max = ($samples | Measure-Object -Maximum).Maximum
$min = ($samples | Measure-Object -Minimum).Minimum
$twoPhaseTotal = $placeMs + $attachMs

Write-Host "`n=== SUMMARY ===" -ForegroundColor Green
"  isTest orderId:       $($r1.orderId)"
"  placeOrder RTT:       ${placeMs} ms"
"  attachScreenshot RTT: ${attachMs} ms"
"  getOrder min/avg/max: ${min} / ${avg} / ${max} ms (n=5)"
Write-Host ""
"  ---- Latency breakdown (measured) ----"
"   * customer submit -> backend text-sync done:      ${placeMs} ms  (UI is optimistic, this is syncStatus syncing->synced behind)"
"   * customer submit -> screenshot stored on Drive:  ${twoPhaseTotal} ms  (two-phase total)"
"   * merchant sees new order:                        worst 15s (merchant poll) + ${avg} ms ~= 16-18 sec"
"   * customer sees status change after merchant act: worst 12s (customer poll) + ${avg} ms ~= 13-15 sec"
"   * customer in background / screen off -> resume:  UNDEFINED; setInterval is throttled; could be >1 min; no visibilitychange = root cause of slow refresh"
Write-Host ""
"NOTE: test order written to PROD backend with isTest=true. Clean up via admin > test tools > clearTestData."
