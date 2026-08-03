---
name: build-log-analyzer
description: 'Find build failure root causes in build.log files. Use when: build failed, why did build fail, check build.log, find errors in log, build error, tsc error, compile error, AMI build failed, EDKII build error, npm build error, make error, what broke the build, build log analysis, 編譯失敗, build 失敗, 找錯誤, 看 log.'
argument-hint: 'path to build.log (optional, auto-detects if omitted)'
user-invocable: true
---

# Build Log Analyzer

## Purpose
Efficiently locate the **root cause failure point** in a build.log without loading the entire file.
Uses streaming grep — safe for very large logs (>100 MB).

## When to Use
- User says "build failed" or "check build.log"
- Need to find which module/file caused the first error
- AMI/UEFI EDKII build log analysis
- TypeScript `tsc` error extraction
- npm / Node.js / make build failures

## Procedure

### Step 1 — Locate the log file
Check these paths in order (stop at first match):
1. Argument provided by user
2. `Build.log` (workspace root, case-insensitive)
3. `build/Build.log`
4. `out/build.log`
5. Ask the user if none found

Use `file_search` with pattern `**/Build.log` or `**/build.log`.

### Step 2 — Stream-scan for errors (DO NOT read the whole file)
Run the PowerShell script: [find-errors.ps1](./scripts/find-errors.ps1)

```powershell
# Quick invocation:
& "C:\Users\YCHsu\.github\skills\build-log-analyzer\scripts\find-errors.ps1" -LogPath "<path>"
```

Or use `grep_search` with these patterns (isRegexp=true):
- `error [A-Z]|error:|ERROR|FAILED|Build FAILED|make\[.*\] \*\*\*`
- For TypeScript: `error TS\d+:`
- For EDKII/AMI: `ERROR - |Module .* failed|FAILED - `

### Step 3 — Find the ROOT CAUSE (first error)
1. Identify the **earliest** error line in the file (lowest line number)
2. Read ±10 lines of context around that first error using `read_file`
3. Distinguish: root cause error vs cascading/downstream errors

### Step 4 — Report
Structure the output as:

```
## Build Failure Summary

**Root Cause** (line N):
<error message>
<context>

**Error Count**: N errors total
**Error Types**: [tsc | make | AMI module | linker | etc.]

**Cascading Errors** (if any): N additional errors likely caused by above
```

## Error Pattern Reference

| Build System | Key Patterns |
|---|---|
| TypeScript tsc | `error TS\d+:`, `Found \d+ error` |
| AMI/EDKII | `ERROR - `, `FAILED - stopping`, `make[N]: ***`, `Build FAILED` |
| npm/Node | `npm ERR!`, `error:` |
| make | `make\[.*\]: \*\*\* .* Error \d+`, `make: \*\*\* No rule` |
| GCC/Clang | `error:.*\[-W`, `: error:` |
| MSVC | `error C\d+:`, `LINK : fatal error` |

## Important Rules
- **NEVER** use `read_file` on the entire log — use `grep_search` + targeted `read_file` for context only
- Report the **first** error, not the last
- If >50 errors of the same type, report count + first 3 examples only
- Always show the file path and line number of the root cause
