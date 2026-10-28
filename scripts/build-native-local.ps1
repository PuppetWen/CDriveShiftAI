param(
  [switch]$Test,
  [switch]$AllowDownloads,
  [ValidateSet("all", "indexer", "updater")][string]$Project = "all",
  [string]$RustRoot = "E:\Environment\rust\1.99.0",
  [string]$LlvmBin = "E:\Environment\ndk\30.0.16248370\toolchains\llvm\prebuilt\windows-x86_64\bin",
  [string]$SdkRoot,
  [string]$CacheSeedRoot
)

$ErrorActionPreference = "Stop"
$workspacePath = Split-Path -Parent $PSScriptRoot
$neighborTools = Join-Path (Split-Path -Parent $workspacePath) "EnvNexusAI\.devtools"
if (-not $SdkRoot) { $SdkRoot = Join-Path $neighborTools "xwin-sdk" }
if (-not $CacheSeedRoot) { $CacheSeedRoot = Join-Path $neighborTools "cargo" }
$toolchain = Get-ChildItem -LiteralPath (Join-Path $RustRoot "rustup\toolchains") -Directory |
  Where-Object { $_.Name -match "^[0-9].*-x86_64-pc-windows-msvc$" } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $toolchain) { throw "No versioned Windows Rust toolchain found under $RustRoot" }
$cargoExe = Join-Path $toolchain.FullName "bin\cargo.exe"
$rustcExe = Join-Path $toolchain.FullName "bin\rustc.exe"
$linkerExe = Join-Path $toolchain.FullName "lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe"
$compilerExe = Join-Path $LlvmBin "clang-cl.exe"
$archiverExe = Join-Path $LlvmBin "llvm-lib.exe"
foreach ($required in @($cargoExe, $rustcExe, $linkerExe, $compilerExe, $archiverExe, (Join-Path $SdkRoot "sdk\lib\um\x86_64\kernel32.Lib"))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required existing tool or SDK file missing: $required" }
}
$cargoCache = Join-Path $workspacePath ".cache\cargo"
$temporaryPath = Join-Path $workspacePath ".task-tmp\native-build"
Write-Host "Tools: $($toolchain.FullName); $LlvmBin"
Write-Host "Read-only SDK: $SdkRoot"
Write-Host "Project dependency cache: $cargoCache"
Write-Host "Project temporary files: $temporaryPath"
New-Item -ItemType Directory -Path $cargoCache, $temporaryPath -Force | Out-Null
$projects = if ($Project -eq "all") { @("indexer", "updater") } else { @($Project) }

# Seed only locked package archives. Cargo extracts sources into the project cache.
$seedIndex = Join-Path $CacheSeedRoot "registry\index"
$cacheIndex = Join-Path $cargoCache "registry\index"
if (-not (Test-Path -LiteralPath $cacheIndex)) {
  if (-not (Test-Path -LiteralPath $seedIndex)) { throw "Offline Cargo index unavailable: $seedIndex" }
  New-Item -ItemType Directory -Path (Split-Path -Parent $cacheIndex) -Force | Out-Null
  Copy-Item -LiteralPath $seedIndex -Destination $cacheIndex -Recurse
}
$seedArchives = Get-ChildItem -LiteralPath (Join-Path $CacheSeedRoot "registry\cache") -Directory
foreach ($nativeProject in $projects) {
  $lockPath = Join-Path $workspacePath "native\$nativeProject\Cargo.lock"
  $lockText = [IO.File]::ReadAllText($lockPath)
  $packages = [regex]::Matches($lockText, '(?m)^name = "([^"]+)"\r?\nversion = "([^"]+)"\r?\nsource = "registry\+')
  foreach ($package in $packages) {
    $archiveName = "$($package.Groups[1].Value)-$($package.Groups[2].Value).crate"
    foreach ($seed in $seedArchives) {
      $destinationDirectory = Join-Path $cargoCache "registry\cache\$($seed.Name)"
      $destination = Join-Path $destinationDirectory $archiveName
      if (Test-Path -LiteralPath $destination) { break }
      $source = Join-Path $seed.FullName $archiveName
      if (Test-Path -LiteralPath $source) {
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
        break
      }
    }
  }
}

$updates = @{
  CARGO_HOME = $cargoCache
  RUSTUP_HOME = (Join-Path $RustRoot "rustup")
  RUSTC = $rustcExe
  RUSTDOC = (Join-Path $toolchain.FullName "bin\rustdoc.exe")
  CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $linkerExe
  CC = $compilerExe
  AR = $archiverExe
  INCLUDE = (@("crt\include", "sdk\include\ucrt", "sdk\include\shared", "sdk\include\um", "sdk\include\winrt") | ForEach-Object { Join-Path $SdkRoot $_ }) -join ";"
  LIB = (@("crt\lib\x86_64", "sdk\lib\ucrt\x86_64", "sdk\lib\um\x86_64") | ForEach-Object { Join-Path $SdkRoot $_ }) -join ";"
  TEMP = $temporaryPath
  TMP = $temporaryPath
}
$previous = @{}
try {
  foreach ($key in $updates.Keys) {
    $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
    [Environment]::SetEnvironmentVariable($key, $updates[$key], "Process")
  }
  Push-Location -LiteralPath $workspacePath
  try {
    foreach ($nativeProject in $projects) {
      $manifestPath = Join-Path $workspacePath "native\$nativeProject\Cargo.toml"
      $arguments = if ($Test) { @("test", "--release", "--locked", "--manifest-path", $manifestPath) } else { @("build", "--release", "--locked", "--manifest-path", $manifestPath) }
      if (-not $AllowDownloads) { $arguments += "--offline" }
      & $cargoExe @arguments
      if ($LASTEXITCODE -ne 0) { throw "Cargo failed for $nativeProject (exit $LASTEXITCODE)" }
    }
  } finally { Pop-Location }
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process") }
}
Write-Host "Native $Project validation completed successfully."
