[CmdletBinding()]
param(
    [Parameter(Position=0, Mandatory=$true)]
    [string]$Action,

    [Parameter(Position=1, Mandatory=$true)]
    [string]$TaskId
)

Write-Warning "ai-flow.ps1 is deprecated. Use 'omni dual phase $Action $TaskId' instead."
& omni dual phase $Action $TaskId
exit $LASTEXITCODE
