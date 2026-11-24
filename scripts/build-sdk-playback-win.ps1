# Build the Windows x64 hongguo-sdk-playback executable from the pinned vendored source.
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Work = Join-Path $Root 'build\sdk-playback'
$Stage = Join-Path $Root 'build\sdk-playback-work'
$Vendor = Join-Path $Root 'scripts\sdk-playback\vendor\phone_account'
$BuildRoot = Join-Path $Stage 'build-win32-x64'
$VenvDir = Join-Path $Stage 'venv-win32-x64'
$OutDir = Join-Path $Work 'win32-x64'

if (-not (Test-Path $Vendor -PathType Container)) {
    throw "Missing vendored SDK playback source: $Vendor"
}

$Python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
& $Python --version | Out-Null
if ($LASTEXITCODE) { throw "Python not found: $Python" }

New-Item -ItemType Directory -Force $Work, $Stage, $BuildRoot, $OutDir | Out-Null
$TargetAccount = Join-Path $BuildRoot 'phone_account'
if (Test-Path $TargetAccount) { Remove-Item -Recurse -Force $TargetAccount }
Copy-Item -Recurse -Force $Vendor $TargetAccount
Copy-Item -Force (Join-Path $Root 'scripts\sdk-playback\resolve_cli.py') (Join-Path $BuildRoot 'resolve_cli.py')

$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$VenvPip = Join-Path $VenvDir 'Scripts\pip.exe'
$VenvPyInstaller = Join-Path $VenvDir 'Scripts\pyinstaller.exe'

if (Test-Path $VenvDir) { Remove-Item -Recurse -Force $VenvDir }
& $Python -m venv $VenvDir
if ($LASTEXITCODE) { throw 'Failed to create Python virtual environment' }

$PreviousCompileBootloader = $env:PYINSTALLER_COMPILE_BOOTLOADER
$PreviousBootloaderWafArgs = $env:PYINSTALLER_BOOTLOADER_WAF_ARGS
try {
    $env:PYINSTALLER_COMPILE_BOOTLOADER = '1'
    $env:PYINSTALLER_BOOTLOADER_WAF_ARGS = '--no-cfg'
    & $VenvPip install --quiet --no-cache-dir --no-binary=pyinstaller pyinstaller==6.22.3
    if ($LASTEXITCODE) { throw 'Failed to build PyInstaller without CFG' }
} finally {
    if ($null -eq $PreviousCompileBootloader) { Remove-Item Env:\PYINSTALLER_COMPILE_BOOTLOADER -ErrorAction SilentlyContinue }
    else { $env:PYINSTALLER_COMPILE_BOOTLOADER = $PreviousCompileBootloader }
    if ($null -eq $PreviousBootloaderWafArgs) { Remove-Item Env:\PYINSTALLER_BOOTLOADER_WAF_ARGS -ErrorAction SilentlyContinue }
    else { $env:PYINSTALLER_BOOTLOADER_WAF_ARGS = $PreviousBootloaderWafArgs }
}

& $VenvPip install --quiet unicorn==2.1.4 requests==2.34.2 pycryptodome==4.6.0
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
