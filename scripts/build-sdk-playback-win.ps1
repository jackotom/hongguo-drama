# Build the Windows x64 hongguo-sdk-playback executable from the pinned vendored source.
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Work = Join-Path $Root 'build\sdk-playback'
$Vendor = Join-Path $Root 'scripts\sdk-playback\vendor\phone_account'
$BuildRoot = Join-Path $Work 'build-win32-x64'
$VenvDir = Join-Path $Work 'venv-win32-x64'
$OutDir = Join-Path $Work 'win32-x64'

if (-not (Test-Path $Vendor -PathType Container)) {
    throw "Missing vendored SDK playback source: $Vendor"
}

$Python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
& $Python --version | Out-Null
if ($LASTEXITCODE) { throw "Python not found: $Python" }

New-Item -ItemType Directory -Force $Work, $BuildRoot, $OutDir | Out-Null
$TargetAccount = Join-Path $BuildRoot 'phone_account'
if (Test-Path $TargetAccount) { Remove-Item -Recurse -Force $TargetAccount }
Copy-Item -Recurse -Force $Vendor $TargetAccount
Copy-Item -Force (Join-Path $Root 'scripts\sdk-playback\resolve_cli.py') (Join-Path $BuildRoot 'resolve_cli.py')

$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$VenvPip = Join-Path $VenvDir 'Scripts\pip.exe'
$VenvPyInstaller = Join-Path $VenvDir 'Scripts\pyinstaller.exe'

if (-not (Test-Path $VenvPython)) {
    & $Python -m venv $VenvDir
    if ($LASTEXITCODE) { throw 'Failed to create Python virtual environment' }
}

& $VenvPip install --quiet pyinstaller==6.22.3 unicorn==2.1.4 requests==2.34.2 pycryptodome==4.6.0
if ($LASTEXITCODE) { throw 'Failed to install SDK playback build dependencies' }

Push-Location $BuildRoot
try {
    & $VenvPyInstaller --noconfirm --clean --onefile `
        --name hongguo-sdk-playback `
        --collect-all unicorn --collect-all Crypto `
        --paths $TargetAccount `
        --add-data "$TargetAccount\vendor;vendor" `
        --add-data "$TargetAccount\medusa_wire_tables.json;." `
        (Join-Path $BuildRoot 'resolve_cli.py')
    if ($LASTEXITCODE) { throw 'PyInstaller failed to build hongguo-sdk-playback.exe' }
} finally {
    Pop-Location
}

$BuiltExe = Join-Path $BuildRoot 'dist\hongguo-sdk-playback.exe'
$FinalExe = Join-Path $OutDir 'hongguo-sdk-playback.exe'
Copy-Item -Force $BuiltExe $FinalExe
Write-Output $FinalExe
