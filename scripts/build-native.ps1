param(
  [switch]$Test
)

$ErrorActionPreference = "Stop"

$workspacePath = Split-Path -Parent $PSScriptRoot
$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswherePath)) {
  throw "Visual Studio vswhere.exe was not found. Install the Desktop development with C++ workload."
}

$visualStudioPath = & $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudioPath) {
  throw "Visual Studio C++ build tools were not found."
}

$developerCommand = Join-Path $visualStudioPath "Common7\Tools\VsDevCmd.bat"
$manifestPaths = @(
  (Join-Path $workspacePath "native\indexer\Cargo.toml"),
  (Join-Path $workspacePath "native\updater\Cargo.toml")
)
$cargoPath = (Get-Command cargo.exe -ErrorAction Stop).Source

& cmd.exe /d /c "`"$developerCommand`" -arch=x64 -host_arch=x64 >nul 2>nul && set" |
  ForEach-Object {
    if ($_ -match "^([^=]+)=(.*)$") {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
    }
  }

$sdkCandidates = @(
  (Join-Path $workspacePath ".devtools\windows-sdk\sdk"),
  (Join-Path (Split-Path -Parent $workspacePath) "EnvNexusAI\.devtools\xwin-sdk\sdk")
)
$sdkPath = $sdkCandidates | Where-Object {
  Test-Path -LiteralPath (Join-Path $_ "lib\um\x86_64\kernel32.Lib")
} | Select-Object -First 1

if ($sdkPath) {
  $sdkLibraries = @(
    (Join-Path $sdkPath "lib\um\x86_64"),
    (Join-Path $sdkPath "lib\ucrt\x86_64")
  )
  $sdkIncludes = @(
    (Join-Path $sdkPath "include\ucrt"),
    (Join-Path $sdkPath "include\shared"),
    (Join-Path $sdkPath "include\um"),
    (Join-Path $sdkPath "include\winrt"),
    (Join-Path $sdkPath "include\cppwinrt")
  )
  $env:LIB = (($sdkLibraries + @($env:LIB)) | Where-Object { $_ }) -join ";"
  $env:INCLUDE = (($sdkIncludes + @($env:INCLUDE)) | Where-Object { $_ }) -join ";"
}

foreach ($manifestPath in $manifestPaths) {
  $cargoArguments = if ($Test) {
    @("test", "--manifest-path", $manifestPath)
  } else {
    @("build", "--manifest-path", $manifestPath, "--release")
  }

  & $cargoPath +1.75.0 @cargoArguments
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
