[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$root='D:\sf-native-acceptance'
$zip="$root\downloads\node-v24.16.0-win-x64.zip"
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'){throw 'Node ZIP checksum mismatch'}
if((Get-FileHash "$root\downloads\vm-wsl2-backend.ts" -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'cf6aaa7b64849aa46ad00f9cef5b3a92bffed2aa73512607e0830c7c8f9016bf'){throw 'Source module checksum mismatch'}
New-Item -ItemType Directory -Path "$root\tools" -Force|Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath "$root\tools" -ErrorAction Stop
$node="$root\tools\node-v24.16.0-win-x64\node.exe"
& $node "$root\evidence\windows-cli-probe.mjs" | Tee-Object -FilePath "$root\evidence\windows-cli-receipt.json"
if($LASTEXITCODE -ne 0){throw 'Native Windows CLI probe failed'}
