---
name: ami-firmware-coding-standards
description: 'AMI Aptio 5.x Firmware Coding Standards validation (INFORMATIONAL). Use when checking firmware-specific coding standards compliance after UEFI code review and Module Developer Guide validation.'
user-invocable: false
disable-model-invocation: false
---

# AMI Firmware Coding Standards Validation (INFORMATIONAL)

## Purpose
Validate reviewed code against **informational** AMI Aptio 5.x Firmware Coding Standards that provide additional style guidance beyond Module Developer's Guide requirements.

**Compliance Level:** INFORMATIONAL - Violations do NOT impact the final review verdict. Findings are tracked for post-merge cleanup.

## When to Use
- **After Module Developer's Guide validation** (Step 3.8 complete)
- To check firmware-specific style and best practices
- Only on files that were already reviewed and passed Module Developer Guide validation

## Scope
This skill checks **firmware-specific style recommendations** only. UEFI/PI/EDK2 spec compliance and Module Developer Guide mandatory standards are already covered.

## Standards Reference
See [Firmware Coding Standards](./Firmware_Coding_Standards.md) for complete firmware-specific style recommendations.

## Validation Procedure

### Step 1: Identify Files in Scope
Review only files that were checked in Module Developer Guide validation (Step 3.8). Do not review files that were skipped or excluded.

### Step 2: Classify File Ownership (AMI vs Third-Party)

Use the same classification logic as Module Developer Guide:

**Classification Rules:**

| Condition | Classification | Validation Scope |
|-----------|----------------|------------------|
| File contains AMI copyright banner (`Copyright (c) 1985-20XX, AMI`) | ✅ **AMI-owned** | Entire file |
| File contains third-party copyright AND contains AMI override markers | ⚙️ **Third-party with AMI overrides** | AMI override sections only |
| File contains NO copyright header | ✅ **AMI-owned** (default assumption) | Entire file |
| File contains only third-party copyright, NO AMI override markers | ❌ **Third-party only** | Skip validation |

**AMI Override Marker Patterns (case-insensitive):**

| Start Marker | End Marker |
|--------------|------------|
| `// AMI OVERRIDE START` | `// AMI OVERRIDE END` |
| `//APTIOV_SERVER_OVERRIDE_START:` | `//APTIOV_SERVER_OVERRIDE_END:` |
| `//APTIOV_SERVER_OVERRIDE_RC_START:` | `//APTIOV_SERVER_OVERRIDE_RC_END:` |

### Step 3: Extract AMI Code Sections

Same extraction logic as Module Developer Guide validation (entire file vs override sections only).

### Step 4: Check Firmware Coding Standards

For each AMI code section, verify firmware-specific style recommendations:

1. **Comment Style** (INFORMATIONAL)
   - Function header comments completeness
   - Code comment clarity and usefulness
   - TODO/FIXME/HACK marker usage

2. **Code Readability** (INFORMATIONAL)
   - Line length recommendations (prefer < 120 characters)
   - Function length guidelines (prefer < 200 lines)
   - Nesting depth (prefer < 5 levels)
   - Variable scope minimization

3. **Error Handling Patterns** (INFORMATIONAL)
   - Consistent error handling style
   - Resource cleanup in error paths
   - Error message clarity

4. **Performance Considerations** (INFORMATIONAL)
   - Unnecessary memory allocations
   - Repeated calculations that could be cached
   - String operations in loops

5. **Maintainability** (INFORMATIONAL)
   - Code duplication detection
   - Magic number usage (prefer named constants)
   - Complex boolean expressions (suggest simplification)

6. **Firmware-Specific Patterns** (INFORMATIONAL)
   - Boot path optimization hints
   - Memory footprint considerations
   - S3 resume path safety

### Step 5: Report Findings

Append findings to the review report under a new section:

```markdown
---

## AMI Firmware Coding Standards (INFORMATIONAL)

Files validated against AMI Aptio 5.x Firmware Coding Standards style recommendations.

### Summary
- Files reviewed for style: X
- Informational observations: Y

### Findings

**[AmiModulePkg/Nvram/NvramDxe.c]** (AMI-owned)
- Comment Style: Function header missing parameter description
  - Location: Line 147
  - Severity: INFO (style recommendation)
  - Suggestion: Add `@param` Doxygen tags for parameters
- Code Readability: Function exceeds recommended length (215 lines)
  - Location: Lines 200-415
  - Severity: INFO (maintainability)
  - Suggestion: Consider refactoring into smaller functions

**[Intel/ClientOneSiliconPkg/Cpu/PeiCpuPolicyLib.c]** (Third-party with AMI overrides)
- [Third-party file — reviewing AMI override sections only: lines 245-260]
- Performance: Repeated calculation in loop
  - Location: Line 252 (inside `//APTIOV_SERVER_OVERRIDE_START:` block)
  - Severity: INFO (optimization opportunity)
  - Suggestion: Calculate `BufferSize = sizeof(BUFFER) * Count` once before loop

### Firmware Coding Standards Verdict
✅ **STYLE COMPLIANT** / ℹ️ **STYLE OBSERVATIONS** (informational only)

> **Note:** Firmware Coding Standards violations are **INFORMATIONAL ONLY** and do not affect the main review verdict (APPROVE/CONDITIONAL/BLOCK). Findings are tracked for post-merge cleanup or next revision.
```

**Reporting Guidelines:**

1. **All findings are INFO severity** - no MAJOR/MINOR/CRITICAL
2. **Use "Suggestion:" instead of "Fix:"** - these are recommendations, not requirements
3. **Group by file classification** (same as Module Developer Guide)
4. **For AMI override sections:** Include line range notation
5. **If no findings:** Write: `> All reviewed files follow firmware coding style recommendations.`

### Step 6: Final Notes
- **Does NOT impact** the main review verdict (APPROVE/CONDITIONAL/BLOCK)
- Firmware Coding Standards violations are **INFORMATIONAL ONLY**
- Findings are suggestions for code quality improvement
- **AMI code only:** Only AMI-owned files and AMI override sections validated
- **Third-party code skipped:** Pure third-party code not validated
- **Post-merge tracking:** All findings go to post-merge improvement backlog

## Severity Levels

All Firmware Coding Standards findings use **INFO** severity only:

| Category | Severity | Examples |
|----------|----------|----------|
| Comment Style | INFO | Missing parameter docs, unclear comments |
| Code Readability | INFO | Long functions, deep nesting, long lines |
| Error Handling | INFO | Inconsistent error handling patterns |
| Performance | INFO | Optimization opportunities, repeated calculations |
| Maintainability | INFO | Code duplication, magic numbers, complex expressions |
| Firmware-Specific | INFO | Boot path optimization, memory footprint hints |

**No findings impact verdict or score.**

## Progressive Loading
The skill loads lightweight validation logic first, then references [Firmware_Coding_Standards.md](./Firmware_Coding_Standards.md) only when detailed guideline text is needed for citation.
