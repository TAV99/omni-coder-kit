$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    $source = Join-Path $PSScriptRoot 'windows-validator-job.cs'
    [void](Add-Type -Path $source -ReferencedAssemblies 'System.Web.Extensions' -ErrorAction Stop)
    [DualValidatorJob]::Run()
    exit 0
} catch {
    [Console]::Error.WriteLine('validator helper initialization failed')
    exit 70
}
