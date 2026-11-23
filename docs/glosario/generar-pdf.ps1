# Regenera Glosario-codigo-Sisgen.pdf a partir de glosario.html (usa Microsoft Edge).
# Uso: powershell -File generar-pdf.ps1
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
$html = Join-Path $aqui 'glosario.html'
$pdf  = 'C:\ProyectoDTE\Glosario-codigo-Sisgen.pdf'
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
& $edge --headless=new --disable-gpu --no-pdf-header-footer "--print-to-pdf=$pdf" ("file:///" + ($html -replace '\\','/')) | Out-Null
Start-Sleep -Seconds 2
Get-Item $pdf | Select-Object FullName, Length, LastWriteTime
