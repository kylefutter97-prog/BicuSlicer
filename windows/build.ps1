# Builds the BicuSlicer Windows app: a folder with Python's official embeddable build, the pinned packages, the
# server and the launcher, then (with Inno Setup's ISCC.exe) BicuSlicer-Setup-<version>.exe. Run on Windows from the
# repo root; the GitHub workflow .github/workflows/windows.yml does exactly this:
#
#     powershell -File windows\build.ps1 -Version 0.6.0
#
# Python itself comes from python.org, checked against the fingerprint below. OrcaSlicer is NOT included: the app
# downloads it on first start (app/orca_app.py).
param(
  [string]$Version = "0.0.0-dev",
  [string]$Out = "build"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PyVersion = "3.12.10"
$PySha256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"   # python-3.12.10-embed-amd64.zip

$root = (Resolve-Path ".").Path
$dist = Join-Path $root "$Out\BicuSlicer"
if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Force $dist | Out-Null

# 1. Python (embeddable, 64-bit)
$zip = Join-Path $root "$Out\python-embed.zip"
Invoke-WebRequest "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip" -OutFile $zip
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $PySha256) { throw "Python download fingerprint mismatch: $got" }
Expand-Archive $zip -DestinationPath "$dist\python"
# let it import its site-packages and BicuSlicer's app folder
$pth = Get-ChildItem "$dist\python\python*._pth" | Select-Object -First 1
Set-Content $pth.FullName "python312.zip`r`n.`r`nLib\site-packages`r`n..\app`r`nimport site"

# 2. The packages (wheels only, every one pinned by hash)
python -m pip install --disable-pip-version-check --no-deps --require-hashes --only-binary=:all: `
  --platform win_amd64 --python-version 3.12 --implementation cp `
  --target "$dist\python\Lib\site-packages" -r "$root\windows\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "pip failed" }

# 3. BicuSlicer: the server and page, the launcher, icons, licences
Copy-Item -Recurse "$root\app" "$dist\app"
Get-ChildItem "$dist\app" -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
Copy-Item "$root\windows\launcher.pyw" "$dist\launcher.pyw"
# every process in the app checks HTTPS certificates with Windows itself (see the file)
Copy-Item "$root\windows\sitecustomize.py" "$dist\python\Lib\site-packages\sitecustomize.py"
Copy-Item "$root\windows\bicuslicer.ico" "$dist\icon.ico"
Copy-Item "$root\app\static\brand\icon-192.png" "$dist\icon.png"
Copy-Item "$root\LICENSE" "$dist\LICENSE.txt"
Copy-Item "$root\THIRD_PARTY_NOTICES.md" "$dist\THIRD_PARTY_NOTICES.md"
Set-Content "$dist\VERSION.txt" $Version

# 4. The installer
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
  & $iscc "/DAppVersion=$Version" "/DSourceDir=$dist" "/O$root\$Out" "$root\windows\installer.iss"
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed" }
} else {
  Write-Warning "Inno Setup not found: built the folder only ($dist)"
}
