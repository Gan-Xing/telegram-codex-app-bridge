Set-StrictMode -Version Latest

function Get-BridgeRoot {
  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\'))
}

function Resolve-AbsolutePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PathValue,
    [string]$BaseDir = (Get-Location).Path
  )

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }

  return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $PathValue))
}

function ConvertTo-StringHashtable {
  param([object]$InputObject)

  $table = @{}
  if ($null -eq $InputObject) {
    return $table
  }

  foreach ($property in $InputObject.PSObject.Properties) {
    $table[$property.Name] = if ($null -eq $property.Value) { '' } else { [string]$property.Value }
  }

  return $table
}

function Get-CurrentUserProfile {
  $value = [Environment]::GetEnvironmentVariable('USERPROFILE', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    return $value
  }
  return [Environment]::GetFolderPath('UserProfile')
}

function Resolve-NodeBin {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
  )

  $candidates = New-Object System.Collections.Generic.List[string]

  if (-not [string]::IsNullOrWhiteSpace($env:NODE_BIN)) {
    $candidates.Add($env:NODE_BIN)
  }

  $candidates.Add((Join-Path $RootDir '..\tools\node-v24.14.0-win-x64\node.exe'))
  $candidates.Add((Join-Path $RootDir 'tools\node-v24.14.0-win-x64\node.exe'))

  foreach ($toolRoot in @((Join-Path $RootDir '..\tools'), (Join-Path $RootDir 'tools'))) {
    if (-not (Test-Path $toolRoot)) {
      continue
    }
    Get-ChildItem -Path $toolRoot -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
      Sort-Object FullName |
      ForEach-Object { $candidates.Add($_.FullName) }
  }

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $candidates.Add($nodeCommand.Source)
  }

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    $resolved = Resolve-AbsolutePath -PathValue $candidate -BaseDir $RootDir
    if ($resolved -and (Test-Path $resolved)) {
      return $resolved
    }
  }

  throw 'node.exe not found. Set NODE_BIN or install Node 24 for Windows.'
}

function Get-EnvFileData {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeBin,
    [Parameter(Mandatory = $true)]
    [string]$RootDir,
    [Parameter(Mandatory = $true)]
    [string]$EnvFile
  )

  if (-not (Test-Path $EnvFile)) {
    throw "Env file not found: $EnvFile"
  }

  $table = @{}
  foreach ($rawLine in [System.IO.File]::ReadAllLines($EnvFile)) {
    if ([string]::IsNullOrWhiteSpace($rawLine)) {
      continue
    }

    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) {
      continue
    }

    $separatorIndex = $rawLine.IndexOf('=')
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $rawLine.Substring(0, $separatorIndex).Trim()
    if ($key.StartsWith('export ')) {
      $key = $key.Substring(7).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($key)) {
      continue
    }

    $value = $rawLine.Substring($separatorIndex + 1)
    if ($value.Length -ge 2) {
      $first = $value[0]
      $last = $value[$value.Length - 1]
      if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
    }

    $table[$key] = $value
  }

  return $table
}

function Get-EffectiveEnvValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Key,
    [Parameter(Mandatory = $true)]
    [hashtable]$EnvData
  )

  $processValue = [Environment]::GetEnvironmentVariable($Key, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) {
    return $processValue
  }

  if ($EnvData.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace($EnvData[$Key])) {
    return [string]$EnvData[$Key]
  }

  return $null
}

function Sanitize-InstanceId {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $sanitized = $Value.Trim().ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $sanitized = $sanitized.Trim('-')
  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    return $null
  }

  return $sanitized
}

function Resolve-BridgeEngine {
  param([string]$Value)

  $normalized = if ($Value) { $Value.Trim().ToLowerInvariant() } else { 'codex' }
  if ($normalized -eq 'gemini') {
    return 'gemini'
  }
  if ($normalized -eq 'claude') {
    return 'claude'
  }

  return 'codex'
}

function Resolve-BridgeInstanceId {
  param(
    [string]$Value,
    [string]$BridgeEngine
  )

  $sanitized = Sanitize-InstanceId $Value
  if ($sanitized) {
    return $sanitized
  }

  if ($BridgeEngine -eq 'codex') {
    return $null
  }

  return $BridgeEngine
}

function Resolve-BridgeHome {
  param(
    [string]$ExplicitHome,
    [string]$LegacyHome,
    [string]$BridgeInstanceId,
    [string]$UserProfile
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitHome)) {
    return Resolve-AbsolutePath -PathValue $ExplicitHome
  }

  if (-not [string]::IsNullOrWhiteSpace($LegacyHome)) {
    return Resolve-AbsolutePath -PathValue $LegacyHome
  }

  if ($BridgeInstanceId) {
    return Join-Path $UserProfile ".telegram-codex-app-bridge\instances\$BridgeInstanceId"
  }

  return Join-Path $UserProfile '.telegram-codex-app-bridge'
}

function Format-EngineDisplayName {
  param([string]$BridgeEngine)

  if ($BridgeEngine -eq 'gemini') {
    return 'Gemini'
  }
  if ($BridgeEngine -eq 'claude') {
    return 'Claude'
  }

  return 'Codex'
}

function Add-PathPrefix {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Prefix,
    [Parameter(Mandatory = $true)]
    [string]$CurrentPath
  )

  $parts = @()
  if (-not [string]::IsNullOrWhiteSpace($Prefix)) {
    $parts += $Prefix
  }
  if (-not [string]::IsNullOrWhiteSpace($CurrentPath)) {
    $parts += $CurrentPath
  }

  return ($parts -join ';')
}

function Escape-XmlValue {
  param([string]$Value)

  if ($null -eq $Value) {
    return ''
  }

  return [System.Security.SecurityElement]::Escape($Value)
}

function Get-NativeExitCode {
  if (Test-Path Variable:LASTEXITCODE) {
    return [int]$LASTEXITCODE
  }

  return 0
}

function Invoke-NodeScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$NodeBin,
    [Parameter(Mandatory = $true)]
    [string]$Script,
    [string[]]$Arguments = @(),
    [switch]$IgnoreExitCode
  )

  $tempFile = [System.IO.Path]::GetTempFileName()
  $scriptPath = [System.IO.Path]::ChangeExtension($tempFile, '.cjs')
  $outputPath = [System.IO.Path]::ChangeExtension($tempFile, '.out')

  try {
    Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    Set-Content -Path $scriptPath -Value $Script -Encoding UTF8

    & $NodeBin $scriptPath @Arguments 1> $outputPath 2>$null
    $exitCode = Get-NativeExitCode
    if ($exitCode -ne 0 -and -not $IgnoreExitCode) {
      throw "Node helper failed with exit code $exitCode."
    }

    if (-not (Test-Path $outputPath)) {
      return ''
    }

    return ([System.IO.File]::ReadAllText($outputPath)).Trim()
  } finally {
    Remove-Item -Path $scriptPath -Force -ErrorAction SilentlyContinue
    Remove-Item -Path $outputPath -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-WindowsHost {
  if ($env:OS -ne 'Windows_NT') {
    throw 'This script only supports Windows.'
  }
}

function Ensure-ElevatedSession {
  $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    throw 'Run this script from an elevated PowerShell session.'
  }
}

function Get-BridgeContext {
  Ensure-WindowsHost

  $rootDir = Get-BridgeRoot
  $nodeBin = Resolve-NodeBin -RootDir $rootDir
  $npmCmd = Join-Path (Split-Path -Parent $nodeBin) 'npm.cmd'
  if (-not (Test-Path $npmCmd)) {
    throw "npm.cmd not found next to node.exe: $npmCmd"
  }

  $envFileInput = if (-not [string]::IsNullOrWhiteSpace($env:ENV_FILE)) { $env:ENV_FILE } else { '.env' }
  $envFile = Resolve-AbsolutePath -PathValue $envFileInput -BaseDir $rootDir
  $envData = Get-EnvFileData -NodeBin $nodeBin -RootDir $rootDir -EnvFile $envFile

  $bridgeEngine = Resolve-BridgeEngine (Get-EffectiveEnvValue -Key 'BRIDGE_ENGINE' -EnvData $envData)
  $bridgeInstanceId = Resolve-BridgeInstanceId -Value (Get-EffectiveEnvValue -Key 'BRIDGE_INSTANCE_ID' -EnvData $envData) -BridgeEngine $bridgeEngine
  $userProfile = Get-CurrentUserProfile
  $bridgeHome = Resolve-BridgeHome `
    -ExplicitHome (Get-EffectiveEnvValue -Key 'BRIDGE_HOME' -EnvData $envData) `
    -LegacyHome (Get-EffectiveEnvValue -Key 'APP_HOME' -EnvData $envData) `
    -BridgeInstanceId $bridgeInstanceId `
    -UserProfile $userProfile

  $serviceLabelBase = Get-EffectiveEnvValue -Key 'SERVICE_LABEL_BASE' -EnvData $envData
  if (-not $serviceLabelBase) {
    $serviceLabelBase = Get-EffectiveEnvValue -Key 'BRIDGE_SERVICE_LABEL' -EnvData $envData
  }
  if (-not $serviceLabelBase) {
    $serviceLabelBase = 'com.ganxing.telegram-codex-app-bridge'
  }

  $serviceLabel = Get-EffectiveEnvValue -Key 'SERVICE_LABEL' -EnvData $envData
  if (-not $serviceLabel) {
    if ($bridgeInstanceId) {
      $serviceLabel = "$serviceLabelBase-$bridgeInstanceId"
    } else {
      $serviceLabel = $serviceLabelBase
    }
  }

  $serviceDescription = Get-EffectiveEnvValue -Key 'SERVICE_DESCRIPTION' -EnvData $envData
  if (-not $serviceDescription) {
    $serviceDescription = "Telegram $(Format-EngineDisplayName $bridgeEngine) App Bridge"
    if ($bridgeInstanceId) {
      $serviceDescription = "$serviceDescription ($bridgeInstanceId)"
    }
  }

  $nodeDir = Split-Path -Parent $nodeBin
  $currentPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
  $pathValue = Add-PathPrefix -Prefix $nodeDir -CurrentPath $currentPath
  $logDir = Join-Path $bridgeHome 'logs'
  $serviceDir = Join-Path $bridgeHome 'service'
  $serviceExePath = Join-Path $serviceDir "$serviceLabel.exe"
  $serviceXmlPath = Join-Path $serviceDir "$serviceLabel.xml"
  $mainScriptPath = Join-Path $rootDir 'dist\main.js'
  $profileHome = Get-CurrentUserProfile
  $statusFile = Get-EffectiveEnvValue -Key 'STATUS_PATH' -EnvData $envData
  if (-not $statusFile) {
    $statusFile = Join-Path $bridgeHome 'runtime\status.json'
  }
  $storePath = Get-EffectiveEnvValue -Key 'STORE_PATH' -EnvData $envData
  if (-not $storePath) {
    $storePath = Join-Path $bridgeHome 'data\bridge.sqlite'
  }

  $serviceEnv = @{
    'APPDATA' = [Environment]::GetEnvironmentVariable('APPDATA', 'Process')
    'BRIDGE_ENGINE' = $bridgeEngine
    'BRIDGE_HOME' = $bridgeHome
    'ENV_FILE' = $envFile
    'HOME' = $profileHome
    'HOMEDRIVE' = [Environment]::GetEnvironmentVariable('HOMEDRIVE', 'Process')
    'HOMEPATH' = [Environment]::GetEnvironmentVariable('HOMEPATH', 'Process')
    'LOCALAPPDATA' = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
    'PATH' = $pathValue
    'USERPROFILE' = $profileHome
  }

  if ($bridgeInstanceId) {
    $serviceEnv['BRIDGE_INSTANCE_ID'] = $bridgeInstanceId
  }

  foreach ($key in @('APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA')) {
    if ([string]::IsNullOrWhiteSpace($serviceEnv[$key])) {
      $serviceEnv.Remove($key)
    }
  }

  return [pscustomobject]@{
    RootDir = $rootDir
    NodeBin = $nodeBin
    NodeDir = $nodeDir
    NpmCmd = $npmCmd
    EnvFile = $envFile
    EnvData = $envData
    BridgeEngine = $bridgeEngine
    BridgeInstanceId = $bridgeInstanceId
    BridgeHome = $bridgeHome
    ServiceId = $serviceLabel
    ServiceName = $serviceDescription
    ServiceDescription = $serviceDescription
    AppLogDir = $logDir
    ServiceDir = $serviceDir
    ServiceExePath = $serviceExePath
    ServiceXmlPath = $serviceXmlPath
    MainScriptPath = $mainScriptPath
    StatusFile = $statusFile
    StorePath = $storePath
    WrapperUrl = if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_SERVICE_WRAPPER_URL)) { $env:WINDOWS_SERVICE_WRAPPER_URL } else { 'https://github.com/winsw/winsw/releases/latest/download/WinSW-x64.exe' }
    WrapperSourcePath = if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_SERVICE_WRAPPER_PATH)) { Resolve-AbsolutePath -PathValue $env:WINDOWS_SERVICE_WRAPPER_PATH -BaseDir $rootDir } else { $null }
    ServiceEnv = $serviceEnv
  }
}

function Ensure-BridgeDirectories {
  param([Parameter(Mandatory = $true)]$Context)

  $dirs = @($Context.BridgeHome, $Context.AppLogDir, $Context.ServiceDir)
  if (-not [string]::IsNullOrWhiteSpace($Context.StatusFile)) {
    $dirs += (Split-Path -Parent $Context.StatusFile)
  }
  if (-not [string]::IsNullOrWhiteSpace($Context.StorePath)) {
    $dirs += (Split-Path -Parent $Context.StorePath)
  }

  foreach ($dir in $dirs) {
    if ([string]::IsNullOrWhiteSpace($dir)) {
      continue
    }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
}

function Ensure-BuiltBridge {
  param([Parameter(Mandatory = $true)]$Context)

  if (-not (Test-Path $Context.MainScriptPath)) {
    throw "dist\main.js not found. Run npm run build first."
  }
}

function Ensure-ServiceWrapperBinary {
  param([Parameter(Mandatory = $true)]$Context)

  Ensure-BridgeDirectories -Context $Context

  if ($Context.WrapperSourcePath) {
    Copy-Item -Force -Path $Context.WrapperSourcePath -Destination $Context.ServiceExePath
    return
  }

  if (Test-Path $Context.ServiceExePath) {
    return
  }

  Invoke-WebRequest -UseBasicParsing -Uri $Context.WrapperUrl -OutFile $Context.ServiceExePath
}

function Write-ServiceWrapperConfig {
  param([Parameter(Mandatory = $true)]$Context)

  Ensure-BridgeDirectories -Context $Context

  $arguments = '"' + $Context.MainScriptPath + '" serve'
  $lines = @(
    '<?xml version="1.0" encoding="utf-8"?>',
    '<service>',
    "  <id>$(Escape-XmlValue $Context.ServiceId)</id>",
    "  <name>$(Escape-XmlValue $Context.ServiceName)</name>",
    "  <description>$(Escape-XmlValue $Context.ServiceDescription)</description>",
    "  <executable>$(Escape-XmlValue $Context.NodeBin)</executable>",
    "  <arguments>$(Escape-XmlValue $arguments)</arguments>",
    "  <workingdirectory>$(Escape-XmlValue $Context.RootDir)</workingdirectory>"
  )

  foreach ($entry in ($Context.ServiceEnv.GetEnumerator() | Sort-Object Name)) {
    $lines += "  <env name=""$(Escape-XmlValue $entry.Key)"" value=""$(Escape-XmlValue $entry.Value)"" />"
  }

  $lines += @(
    "  <logpath>$(Escape-XmlValue $Context.AppLogDir)</logpath>",
    '  <log mode="roll-by-size">',
    '    <sizeThreshold>10240</sizeThreshold>',
    '    <keepFiles>8</keepFiles>',
    '  </log>',
    '  <stoptimeout>15000</stoptimeout>',
    '  <onfailure action="restart" delay="10 sec" />',
    '  <onfailure action="restart" delay="20 sec" />',
    '  <onfailure action="restart" delay="60 sec" />',
    '</service>',
    ''
  )

  Set-Content -Path $Context.ServiceXmlPath -Value $lines -Encoding UTF8
}

function Test-ServiceInstalled {
  param([Parameter(Mandatory = $true)]$Context)

  return $null -ne (Get-Service -Name $Context.ServiceId -ErrorAction SilentlyContinue)
}
