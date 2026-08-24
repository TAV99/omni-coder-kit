[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsList
)

$joinedArgs = $ArgsList -join " "

if ($ArgsList -contains "--version") {
    Write-Output "agy 1.0.0-test"
    exit 0
}

$behavior = if ($env:FAKE_AGY_BEHAVIOR) { $env:FAKE_AGY_BEHAVIOR } else { "success" }

if ($behavior -eq "malformed") {
    Write-Output "MALFORMED_OUTPUT_NOT_JSON {{{{"
    exit 0
}

if ($behavior -eq "fail_exit") {
    [Console]::Error.WriteLine("Simulated agy process crash")
    exit 2
}

if ($behavior -eq "error_envelope") {
    $errEnvelope = @{
        status = "error"
        message = "Model execution rejected"
    } | ConvertTo-Json
    Write-Output $errEnvelope
    exit 0
}

if ($behavior -eq "invalid_schema") {
    $invEnvelope = @{
        status = "success"
        structured_output = @{
            summary = "Missing exact_symbols"
            relevant_files = @()
        }
    } | ConvertTo-Json -Depth 5
    Write-Output $invEnvelope
    exit 0
}

# Default: success
$successOutput = @{
    type = "result"
    status = "success"
    structured_output = [ordered]@{
        summary = "Scout completed analysis successfully"
        relevant_files = @(
            [ordered]@{
                path = "lib/commands/init.js"
                description = "CLI init command implementation"
            }
        )
        exact_symbols = @(
            [ordered]@{
                name = "buildInitConfig"
                file = "lib/init/strategies.js"
                verified = $true
                kind = "function"
            }
        )
        validation_commands = @(
            "node --test test/init.test.js"
        )
        constraints = @(
            "Read-only operation"
        )
        risks = @(
            "None identified"
        )
        open_questions = @()
    }
} | ConvertTo-Json -Depth 5

Write-Output $successOutput
exit 0
