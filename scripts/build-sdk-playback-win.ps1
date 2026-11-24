# SPDX-License-Identifier: GPL-3.0-only
param(
    [string]$Arch = 'x64',
    [string]$Python = $env:PYTHON
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This helper build currently supports Windows only.'
}
if ($Arch -ne 'x64') {
    throw "Architecture must be x64 (got '$Arch')."
}

$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root "build\sdk-playback\win32-$Arch"
$StageRoot = Join-Path $Root ".cache\sdk-playback\win32-$Arch"
$BuildRoot = Join-Path $StageRoot 'build'
$VenvDir = Join-Path $StageRoot 'venv'
$VendorDir = Join-Path $Root 'scripts\sdk-playback\vendor\phone_account'
$SourceDir = Join-Path $StageRoot 'source'
$Archive = Join-Path $SourceDir 'hongguo-1.0.104-third-party-sources.zip'
$SourceSha = 'beebd9847e3214ca280cfe71320fb89eb2d5b4db18659803a3404ddac75dd5db'
$SourceUrl = 'https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases/releases/download/v1.0.104/hongguo-1.0.104-third-party-sources.zip'

function Test-PythonCandidate {
    param([string]$Exe, [string[]]$PrefixArgs = @())
    if (-not $Exe -or $Exe -like '*\WindowsApps\*') {
        return $null
    }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $probe = & $Exe @PrefixArgs -c "import sys, struct; print(sys.executable); sys.exit(0 if sys.version_info >= (3, 10) and struct.calcsize('P') * 8 == 64 else 1)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $probe) {
            return ($probe | Select-Object -Last 1).Trim()
        }
    } catch {} finally {
        $ErrorActionPreference = $prev
    }
    return $null
}

function Find-UvExecutable {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $localUv = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $localUv) { return $localUv }
    return $null
}

function Resolve-PythonExecutable {
    param([string]$Requested)
    if ($Requested) {
        $found = Test-PythonCandidate -Exe $Requested
        if (-not $found) {
            throw "Requested Python '$Requested' is unavailable or not 64-bit Python >= 3.10."
        }
        return $found
    }

    foreach ($cmd in @('python', 'python3')) {
        $info = Get-Command $cmd -ErrorAction SilentlyContinue
        if ($info) {
            $found = Test-PythonCandidate -Exe $info.Source
            if ($found) { return $found }
        }
    }

    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        foreach ($ver in @('-3.11', '-3.12', '-3')) {
            $found = Test-PythonCandidate -Exe $pyLauncher.Source -PrefixArgs @($ver)
            if ($found) { return $found }
        }
    }

    $uvExe = Find-UvExecutable
    if ($uvExe) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            foreach ($ver in @('3.11', '3.12', '3')) {
                $uvPath = (& $uvExe python find $ver 2>$null | Select-Object -Last 1)
                if ($LASTEXITCODE -eq 0 -and $uvPath) {
                    $found = Test-PythonCandidate -Exe $uvPath.Trim()
                    if ($found) { return $found }
                }
            }
        } finally {
            $ErrorActionPreference = $prev
        }
    }

    throw '64-bit Python >= 3.10 not found. Install Python 3.11+ or set PYTHON.'
}

$PythonExe = Resolve-PythonExecutable -Requested $Python
New-Item -ItemType Directory -Force -Path $OutDir, $BuildRoot | Out-Null

$StagedPhoneAccount = Join-Path $BuildRoot 'phone_account'
if (Test-Path $StagedPhoneAccount) {
    Remove-Item -Recurse -Force $StagedPhoneAccount
}

if (Test-Path $VendorDir) {
    Copy-Item -Recurse -Force $VendorDir $StagedPhoneAccount
} else {
    New-Item -ItemType Directory -Force -Path $SourceDir | Out-Null
    if (-not (Test-Path $Archive)) {
        Invoke-WebRequest -Uri $SourceUrl -OutFile $Archive -UseBasicParsing
    }
    $actualSha = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha -ne $SourceSha) {
        Remove-Item -Force $Archive -ErrorAction SilentlyContinue
        throw "Source archive SHA256 mismatch: expected $SourceSha, got $actualSha"
    }
    $Expanded = Join-Path $SourceDir 'expanded'
    if (Test-Path $Expanded) { Remove-Item -Recurse -Force $Expanded }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Expanded -Force
    Copy-Item -Recurse -Force (Join-Path $Expanded 'desktop-app-1.0.59\source-tree\work\library-search\scripts\phone-account-protocol') $StagedPhoneAccount
    Copy-Item -Force (Join-Path $Expanded 'desktop-account-1.0.19\medusa_wire_tables.json') $StagedPhoneAccount
}

Copy-Item -Force (Join-Path $Root 'scripts\sdk-playback\resolve_cli.py') (Join-Path $BuildRoot 'resolve_cli.py')

$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$UvExe = Find-UvExecutable
if (-not (Test-Path $VenvPython)) {
    & $PythonExe -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        if (-not $UvExe) { throw 'Failed to create Python virtual environment.' }
        & $UvExe venv $VenvDir --python $PythonExe --seed
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python virtual environment via uv.' }
    }
}

$Packages = @('pyinstaller==6.22.3', 'unicorn==2.1.4', 'requests==2.34.2', 'pycryptodome==4.6.0')
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $VenvPython -m pip --version 2>$null | Out-Null
$hasPip = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prev
if ($hasPip) {
    & $VenvPython -m pip install --quiet --disable-pip-version-check @Packages
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed.' }
} else {
    if (-not $UvExe) { throw 'Neither pip nor uv is available to install build dependencies.' }
    & $UvExe pip install --python $VenvPython @Packages
    if ($LASTEXITCODE -ne 0) { throw 'uv pip install failed.' }
}

$PyInstaller = Join-Path $VenvDir 'Scripts\pyinstaller.exe'
if (-not (Test-Path $PyInstaller)) {
    throw "PyInstaller executable missing at $PyInstaller"
}

Push-Location $BuildRoot
try {
    & $PyInstaller --noconfirm --clean --onefile `
        --name hongguo-sdk-playback `
        --collect-all unicorn --collect-all Crypto `
        --paths "$BuildRoot\phone_account" `
        --add-data "$BuildRoot\phone_account\vendor;vendor" `
        --add-data "$BuildRoot\phone_account\medusa_wire_tables.json;." `
        "$BuildRoot\resolve_cli.py"
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$BuiltExe = Join-Path $BuildRoot 'dist\hongguo-sdk-playback.exe'
$TargetExe = Join-Path $OutDir 'hongguo-sdk-playback.exe'
if (-not (Test-Path $BuiltExe)) {
    throw "Expected built executable missing at $BuiltExe"
}
# PyInstaller's Windows bootloader enables Control Flow Guard (GUARD_CF), which
# triggers 0xC0000409 (__fastfail) when Unicorn's TCG JIT executes dynamic blocks.
& $VenvPython -c "import pefile, shutil, sys; src, dst = sys.argv[1], sys.argv[2]; pe = pefile.PE(src, fast_load=True); pe.OPTIONAL_HEADER.DllCharacteristics &= ~0x4000; pe.OPTIONAL_HEADER.CheckSum = pe.generate_checksum(); tmp = dst + '.tmp'; pe.write(tmp); pe.close(); shutil.move(tmp, dst)" $BuiltExe $TargetExe
if ($LASTEXITCODE -ne 0) {
    throw 'Failed to clear GUARD_CF and finalize Windows SDK playback executable.'
}
Write-Output $TargetExe
