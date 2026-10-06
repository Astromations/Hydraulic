[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string] $InstallerPath,

    [string] $Repository = "Astromations/Peak---Video-Compressor"
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "Hydraulic can only be installed on Windows."
}

$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$downloadedInstaller = $false

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $installers = @(Get-ChildItem -Path $scriptDirectory -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in ".exe", ".msi" } |
        Sort-Object LastWriteTime -Descending)

    if ($installers.Count -gt 0) {
        $InstallerPath = $installers[0].FullName
    } else {
        $releaseApiUrl = "https://api.github.com/repos/$Repository/releases/latest"
        Write-Host "Finding the latest Hydraulic release..."
        $release = (iwr -UseBasicParsing -Uri $releaseApiUrl).Content | ConvertFrom-Json
        $asset = @($release.assets |
            Where-Object { $_.name -match '\.(exe|msi)$' } |
            Sort-Object @{ Expression = { if ($_.name -match '\.exe$') { 0 } else { 1 } } }, name)[0]

        if ($null -eq $asset) {
            throw "No Windows .exe or .msi installer was found in release $($release.tag_name)."
        }

        $InstallerPath = Join-Path ([System.IO.Path]::GetTempPath()) $asset.name
        Write-Host "Downloading $($asset.name)..."
        iwr -UseBasicParsing -Uri $asset.browser_download_url -OutFile $InstallerPath
        $downloadedInstaller = $true
    }
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

try {
    if ($installer.Extension -eq ".msi") {
        $process = Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", $installer.FullName -Verb RunAs -Wait -PassThru
    } else {
        $process = Start-Process -FilePath $installer.FullName -Verb RunAs -Wait -PassThru
    }
} finally {
    if ($downloadedInstaller) {
        Remove-Item -LiteralPath $installer.FullName -Force -ErrorAction SilentlyContinue
    }
}

if ($process.ExitCode -ne 0) {
    throw "Hydraulic installer exited with code $($process.ExitCode)."
}

Write-Host "Hydraulic installation completed."