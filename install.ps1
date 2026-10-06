[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $InstallerPath
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Hydraulic can only be installed on Windows."
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $installers = @(Get-ChildItem -Path $scriptDirectory -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in ".exe", ".msi" } |
        Sort-Object LastWriteTime -Descending)

    if ($installers.Count -eq 0) {
        throw "No .exe or .msi installer was found next to install.ps1. Pass the installer path as the first argument."
    }

    $InstallerPath = $installers[0].FullName
} else {
    $InstallerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallerPath)
}

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Installer not found: $InstallerPath"
}

$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Extension -notin ".exe", ".msi") {
    throw "Installer must be an .exe or .msi file: $InstallerPath"
}

Write-Host "Starting Hydraulic installer: $($installer.Name)"

if ($installer.Extension -eq ".msi") {
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $installer.FullName -Verb RunAs -Wait -PassThru
} else {
    $process = Start-Process -FilePath $installer.FullName -Verb RunAs -Wait -PassThru
}

if ($process.ExitCode -ne 0) {
    throw "Hydraulic installer exited with code $($process.ExitCode)."
}

Write-Host "Hydraulic installation completed."