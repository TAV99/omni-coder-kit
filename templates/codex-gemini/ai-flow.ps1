[CmdletBinding()]
param(
    [Parameter(Position=0, Mandatory=$true)]
    [string]$Action,

    [Parameter(Position=1, Mandatory=$true)]
    [string]$TaskId
)

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    $dir = Split-Path $Path -Parent
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-GeminiWorker {
    param([string]$AgyBin, [string]$Mode, [string]$Prompt)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    if ($AgyBin -match '\.ps1$') {
        $psi.FileName = "powershell.exe"
        $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$AgyBin`" --model gemini-3.7-flash-high --effort high --mode $Mode -p --output-format json `"$Prompt`""
    } else {
        $psi.FileName = $AgyBin
        $psi.Arguments = "--model gemini-3.7-flash-high --effort high --mode $Mode -p --output-format json `"$Prompt`""
    }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEnd()
    $stderr = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    return [ordered]@{ exit_code = $proc.ExitCode; stdout = $stdout; stderr = $stderr }
}

if ($TaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    [Console]::Error.WriteLine("Invalid task ID '$TaskId'. Must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    exit 1
}

$repoRoot = (git rev-parse --show-toplevel 2>$null)
if (-not $repoRoot) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    $repoRoot = $repoRoot.Trim()
}

$runDir = Join-Path $repoRoot ".omni\codex-gemini\runs\$TaskId"
$rawDir = Join-Path $runDir "raw"

switch ($Action.ToLower()) {
    "new" {
        $requestFile = Join-Path $runDir "request.md"
        if (Test-Path $requestFile) {
            [Console]::Error.WriteLine("Task '$TaskId' already exists with a request file at '$requestFile'.")
            exit 1
        }
        if (-not (Test-Path $rawDir)) {
            New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
        }
        $requestTemplate = @"
# Task: $TaskId

## Goal
[Describe the specific goal for this task]

## In Scope
- [Files, modules, or features to modify/create]

## Out of Scope
- [Unrelated areas or forbidden changes]

## Validation Commands
- [Commands to run to verify changes]
"@
        Write-Utf8NoBom -Path $requestFile -Content $requestTemplate
        Write-Host "Created task $TaskId at $runDir"
        exit 0
    }

    "preflight" {
        if (-not (Test-Path $runDir)) {
            [Console]::Error.WriteLine("Task '$TaskId' not found. Run 'new $TaskId' first.")
            exit 1
        }
        $preflightFile = Join-Path $runDir "preflight.json"
        $agyBin = if ($env:OMNI_AGY_BIN) { $env:OMNI_AGY_BIN } else { "agy" }

        $branchStatus = ""
        $head = ""
        $isClean = $true
        try {
            $branchStatus = (git status --short --branch 2>&1 | Out-String).Trim()
            $head = (git rev-parse HEAD 2>&1 | Out-String).Trim()
            $shortStatus = (git status --short 2>&1 | Out-String).Trim()
            if ($shortStatus.Length -gt 0) {
                $isClean = $false
            }
        } catch {
            $isClean = $false
        }

        $agyAvailable = $false
        $agyVersion = ""
        try {
            $psiVer = New-Object System.Diagnostics.ProcessStartInfo
            if ($agyBin -match '\.ps1$') {
                $psiVer.FileName = "powershell.exe"
                $psiVer.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$agyBin`" --version"
            } else {
                $psiVer.FileName = $agyBin
                $psiVer.Arguments = "--version"
            }
            $psiVer.RedirectStandardOutput = $true
            $psiVer.RedirectStandardError = $true
            $psiVer.UseShellExecute = $false
            $psiVer.CreateNoWindow = $true

            $procVer = [System.Diagnostics.Process]::Start($psiVer)
            $verOut = $procVer.StandardOutput.ReadToEnd()
            $procVer.WaitForExit()
            if ($procVer.ExitCode -eq 0 -and $verOut.Trim().Length -gt 0) {
                $agyAvailable = $true
                $agyVersion = $verOut.Trim()
            }
        } catch {
            $agyAvailable = $false
        }

        $status = "safe"
        $warnings = @()
        if (-not $agyAvailable) {
            $status = "blocked"
            $warnings += "Antigravity CLI (agy) is not available or failed version check."
        } elseif (-not $isClean) {
            $status = "warning"
            $warnings += "Git working tree has uncommitted changes."
        }

        $preflightObj = [ordered]@{
            task_id = $TaskId
            status = $status
            timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            repo_root = $repoRoot
            git = [ordered]@{
                branch_status = $branchStatus
                head = $head
                clean = $isClean
            }
            agy = [ordered]@{
                available = $agyAvailable
                version = $agyVersion
            }
            forbidden_actions = @(
                "commit",
                "push",
                "deploy",
                "model_cost",
                "global_permission_bypass"
            )
            warnings = $warnings
        }

        $jsonContent = $preflightObj | ConvertTo-Json -Depth 5
        Write-Utf8NoBom -Path $preflightFile -Content $jsonContent
        Write-Host "Preflight check for $TaskId complete. Status: $status"
        exit 0
    }

    "scout" {
        $requestFile = Join-Path $runDir "request.md"
        if (-not (Test-Path $requestFile)) {
            [Console]::Error.WriteLine("Missing request.md for task '$TaskId'.")
            exit 1
        }
        $reqText = (Get-Content $requestFile -Raw)
        if (-not $reqText -or $reqText.Trim().Length -eq 0) {
            [Console]::Error.WriteLine("request.md is empty for task '$TaskId'.")
            exit 1
        }

        $preflightFile = Join-Path $runDir "preflight.json"
        if (-not (Test-Path $preflightFile)) {
            [Console]::Error.WriteLine("Missing preflight.json for task '$TaskId'. Run 'preflight $TaskId' first.")
            exit 1
        }
        $preflightData = Get-Content $preflightFile -Raw | ConvertFrom-Json
        if ($preflightData.status -ne "safe") {
            [Console]::Error.WriteLine("Preflight status must be safe for task '$TaskId' (found '$($preflightData.status)').")
            exit 1
        }

        $schemaPath = Join-Path $repoRoot ".omni\codex-gemini\schemas\context.schema.json"
        $promptPath = Join-Path $repoRoot ".omni\codex-gemini\prompts\scout.md"
        $contextFile = Join-Path $runDir "context.json"
        $rawStdoutFile = Join-Path $rawDir "scout.stdout.json"
        $rawStderrFile = Join-Path $rawDir "scout.stderr.txt"
        $agyBin = if ($env:OMNI_AGY_BIN) { $env:OMNI_AGY_BIN } else { "agy" }

        $scoutPrompt = (Get-Content $promptPath -Raw) + "`n`n## Task Request`n`n" + $reqText

        if (-not (Test-Path $rawDir)) {
            New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
        }

        $rawText = ""
        $rawErr = ""
        $execExitCode = 0
        try {
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            if ($agyBin -match '\.ps1$') {
                $psi.FileName = "powershell.exe"
                $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$agyBin`" -p --output-format json --json-schema `"$schemaPath`" `"$scoutPrompt`""
            } else {
                $psi.FileName = $agyBin
                $psi.Arguments = "-p --output-format json --json-schema `"$schemaPath`" `"$scoutPrompt`""
            }
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $psi.WorkingDirectory = $repoRoot

            $proc = [System.Diagnostics.Process]::Start($psi)
            $rawText = $proc.StandardOutput.ReadToEnd()
            $rawErr = $proc.StandardError.ReadToEnd()
            $proc.WaitForExit()
            $execExitCode = $proc.ExitCode
        } catch {
            $execExitCode = 1
            $rawErr = $_.Exception.Message
        }

        Write-Utf8NoBom -Path $rawStdoutFile -Content $rawText
        Write-Utf8NoBom -Path $rawStderrFile -Content $rawErr

        if ($execExitCode -ne 0) {
            [Console]::Error.WriteLine("agy scout execution failed with exit code $execExitCode")
            exit $execExitCode
        }

        if (-not $rawText -or $rawText.Trim().Length -eq 0) {
            [Console]::Error.WriteLine("agy scout returned empty output")
            exit 1
        }

        $parsed = $null
        try {
            $parsed = $rawText | ConvertFrom-Json
        } catch {
            [Console]::Error.WriteLine("agy scout returned malformed JSON: $($_.Exception.Message)")
            exit 1
        }

        # Envelope verification
        $isSuccess = ($parsed.status -eq "SUCCESS" -or $parsed.status -eq "success" -or $parsed.type -eq "result")
        if (-not $isSuccess -or $parsed.status -eq "error") {
            [Console]::Error.WriteLine("agy scout envelope status is not success")
            exit 1
        }

        # Extract structured data
        $struct = $null
        if ($parsed.PSObject.Properties['structured_output'] -and $parsed.structured_output) {
            $struct = $parsed.structured_output
        } elseif ($parsed.PSObject.Properties['summary']) {
            $struct = $parsed
        } else {
            [Console]::Error.WriteLine("Missing structured_output in agy scout result")
            exit 1
        }

        # Strict schema validation
        $requiredFields = @("summary", "relevant_files", "exact_symbols", "validation_commands", "constraints", "risks", "open_questions")
        foreach ($f in $requiredFields) {
            if (-not $struct.PSObject.Properties[$f]) {
                [Console]::Error.WriteLine("Schema violation: missing required property '$f'")
                exit 1
            }
        }

        if (-not $struct.summary -or ([string]$struct.summary).Trim().Length -eq 0) {
            [Console]::Error.WriteLine("Schema violation: 'summary' must be a non-empty string")
            exit 1
        }

        foreach ($rf in @($struct.relevant_files)) {
            if (-not $rf.path -or ([string]$rf.path).Trim().Length -eq 0) {
                [Console]::Error.WriteLine("Schema violation: relevant_files items must have non-empty 'path'")
                exit 1
            }
        }

        foreach ($sym in @($struct.exact_symbols)) {
            if ($null -eq $sym.verified) {
                [Console]::Error.WriteLine("Schema violation: exact_symbols items must have boolean 'verified'")
                exit 1
            }
            if (-not $sym.name -or ([string]$sym.name).Trim().Length -eq 0) {
                [Console]::Error.WriteLine("Schema violation: exact_symbols items must have non-empty 'name'")
                exit 1
            }
            if (-not $sym.file -or ([string]$sym.file).Trim().Length -eq 0) {
                [Console]::Error.WriteLine("Schema violation: exact_symbols items must have non-empty 'file'")
                exit 1
            }
        }

        $contextJson = $struct | ConvertTo-Json -Depth 10
        Write-Utf8NoBom -Path $contextFile -Content $contextJson
        Write-Host "Scout completed successfully for $TaskId. Context saved to $contextFile"
        exit 0
    }

    "route" {
        $specFile = Join-Path $runDir "spec.json"
        if (-not (Test-Path $specFile)) {
            [Console]::Error.WriteLine("Missing spec.json for task '$TaskId'. Codex must define bounded scope before routing.")
            exit 1
        }

        try {
            $spec = Get-Content $specFile -Raw | ConvertFrom-Json
        } catch {
            [Console]::Error.WriteLine("Malformed spec.json for task '$TaskId': $($_.Exception.Message)")
            exit 1
        }

        $scope = @($spec.in_scope)
        $validation = @($spec.validation_commands)
        $risks = @($spec.risk_flags)
        $hasBlockingRisk = $false
        foreach ($risk in $risks) {
            if ([string]$risk -match '(?i)architecture|security|migration|cross-module|ambiguous') {
                $hasBlockingRisk = $true
                break
            }
        }

        $eligible = $scope.Count -gt 0 -and $scope.Count -le 3 -and $validation.Count -gt 0 -and -not $hasBlockingRisk
        $owner = if ($eligible) { "gemini" } else { "codex" }
        $reason = if ($eligible) {
            "Bounded low-risk task with validation commands."
        } elseif ($scope.Count -eq 0 -or $validation.Count -eq 0) {
            "Incomplete spec: scope and validation commands are mandatory."
        } elseif ($scope.Count -gt 3) {
            "Scope exceeds the three-file Gemini limit."
        } else {
            "Task carries an architecture, security, migration, cross-module, or ambiguity risk."
        }

        $route = [ordered]@{
            task_id = $TaskId
            owner = $owner
            model = if ($eligible) { "gemini-3.7-flash-high" } else { $null }
            effort = if ($eligible) { "high" } else { $null }
            token_budget = if ($eligible) { 12000 } else { $null }
            allowed_files = $scope
            reason = $reason
        }
        Write-Utf8NoBom -Path (Join-Path $runDir "route.json") -Content ($route | ConvertTo-Json -Depth 5)
        Write-Host "Route for ${TaskId}: $owner. $reason"
        exit 0
    }

    "implement" {
        $preflightFile = Join-Path $runDir "preflight.json"
        $routeFile = Join-Path $runDir "route.json"
        $specFile = Join-Path $runDir "spec.json"
        if (-not (Test-Path $preflightFile) -or -not (Test-Path $routeFile) -or -not (Test-Path $specFile)) {
            [Console]::Error.WriteLine("implement requires preflight.json, route.json, and spec.json for task '$TaskId'.")
            exit 1
        }
        $preflight = Get-Content $preflightFile -Raw | ConvertFrom-Json
        $route = Get-Content $routeFile -Raw | ConvertFrom-Json
        if ($preflight.status -ne "safe" -or $route.owner -ne "gemini") {
            [Console]::Error.WriteLine("implement is allowed only for a safe Gemini-owned route.")
            exit 1
        }
        $agyBin = if ($env:OMNI_AGY_BIN) { $env:OMNI_AGY_BIN } else { "agy" }
        $prompt = (Get-Content (Join-Path $repoRoot ".omni\codex-gemini\prompts\implement.md") -Raw) + "`n`n## Task Spec`n" + (Get-Content $specFile -Raw)
        try { $result = Invoke-GeminiWorker -AgyBin $agyBin -Mode "accept-edits" -Prompt $prompt } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
        if ($result.exit_code -ne 0) { [Console]::Error.WriteLine("Gemini implement failed with exit code $($result.exit_code)"); exit $result.exit_code }
        try { $parsed = $result.stdout | ConvertFrom-Json } catch { [Console]::Error.WriteLine("Gemini implement returned malformed JSON"); exit 1 }
        if ($parsed.status -eq "error" -or (-not $parsed.structured_output -and $parsed.type -ne "result")) { [Console]::Error.WriteLine("Gemini implement returned an invalid envelope"); exit 1 }
        $evidence = if ($parsed.structured_output) { $parsed.structured_output } else { $parsed }
        Write-Utf8NoBom -Path (Join-Path $runDir "evidence.json") -Content ($evidence | ConvertTo-Json -Depth 10)
        Write-Host "Gemini implementation evidence saved for $TaskId"
        exit 0
    }

    "review" {
        $preflightFile = Join-Path $runDir "preflight.json"
        $routeFile = Join-Path $runDir "route.json"
        $specFile = Join-Path $runDir "spec.json"
        $evidenceFile = Join-Path $runDir "evidence.json"
        if (-not (Test-Path $preflightFile) -or -not (Test-Path $routeFile) -or -not (Test-Path $specFile) -or -not (Test-Path $evidenceFile)) { [Console]::Error.WriteLine("review requires preflight, route, spec, and evidence artifacts."); exit 1 }
        $preflight = Get-Content $preflightFile -Raw | ConvertFrom-Json; $route = Get-Content $routeFile -Raw | ConvertFrom-Json
        if ($preflight.status -ne "safe" -or $route.owner -ne "gemini") { [Console]::Error.WriteLine("review is allowed only for a safe Gemini-owned route."); exit 1 }
        $agyBin = if ($env:OMNI_AGY_BIN) { $env:OMNI_AGY_BIN } else { "agy" }
        $prompt = (Get-Content (Join-Path $repoRoot ".omni\codex-gemini\prompts\review.md") -Raw) + "`n`n## Task Spec`n" + (Get-Content $specFile -Raw) + "`n`n## Evidence`n" + (Get-Content $evidenceFile -Raw)
        try { $result = Invoke-GeminiWorker -AgyBin $agyBin -Mode "plan" -Prompt $prompt } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
        if ($result.exit_code -ne 0) { [Console]::Error.WriteLine("Gemini review failed with exit code $($result.exit_code)"); exit $result.exit_code }
        try { $parsed = $result.stdout | ConvertFrom-Json } catch { [Console]::Error.WriteLine("Gemini review returned malformed JSON"); exit 1 }
        if ($parsed.status -eq "error" -or (-not $parsed.structured_output -and $parsed.type -ne "result")) { [Console]::Error.WriteLine("Gemini review returned an invalid envelope"); exit 1 }
        $review = if ($parsed.structured_output) { $parsed.structured_output } else { $parsed }
        Write-Utf8NoBom -Path (Join-Path $runDir "review.json") -Content ($review | ConvertTo-Json -Depth 10)
        Write-Host "Gemini review saved for $TaskId"
        exit 0
    }

    Default {
        [Console]::Error.WriteLine("Unsupported action '$Action'. Supported actions are: new, preflight, scout, route, implement, review")
        exit 1
    }
}
