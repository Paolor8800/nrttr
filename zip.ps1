$ErrorActionPreference='Stop'
$dest='C:\Users\simular\AppData\Roaming\simular-unified-ui\SimularFiles\artifacts\uznai-druzey'
$out='C:\Users\simular\AppData\Roaming\simular-unified-ui\SimularFiles\artifacts\uznai-druzey-final.zip'
if(Test-Path $out){Remove-Item $out -Force}
Compress-Archive -Path (Join-Path $dest '*') -DestinationPath $out -Force
Write-Output ((Get-Item $out).Length)
