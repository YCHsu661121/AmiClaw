---
name: ami-module-developer-standards
description: 'AMI Aptio 5.x Module Developer Guide standards validation (MANDATORY). Use when validating mandatory organization standards that impact review verdict after UEFI code review completion.'
user-invocable: false
disable-model-invocation: false
---

# AMI Module Developer's Guide Standards Validation (MANDATORY)

## Purpose
Validate reviewed code against **mandatory** AMI Aptio 5.x Module Developer's Guide standards that extend beyond UEFI 2.10+, PI 1.8+, and EDK II C Coding Standard 2.2+ requirements.

**Compliance Level:** MANDATORY - Violations impact the final review verdict and may trigger CONDITIONAL APPROVE or BLOCK.

## When to Use
- **At the end of UEFI code review** (after Stage 3 verdict is written)
- To check AMI-specific organization coding standards
- Only on files that were already reviewed for UEFI/PI/EDK2 compliance

## Scope
This skill checks **AMI-specific mandatory** patterns only. UEFI/PI/EDK2 spec compliance is already covered by the main review stages.

## Standards Reference
See [AMI Module Developer Standards](./Module_Developer_Standards.md) for complete mandatory organization requirements.

## Validation Procedure

### Step 1: Identify Files in Scope
Review only files that were checked in the main review (listed in `cc_registry.md` with Review Status ≠ `NA`). Do not review files that were skipped or excluded.

### Step 2: Classify File Ownership (AMI vs Third-Party)

For each in-scope file, determine ownership by reading the file header (first 50 lines):

**Classification Rules:**

| Condition | Classification | Validation Scope |
|-----------|----------------|------------------|
| File contains AMI copyright banner (`Copyright (c) 1985-20XX, AMI`) | ✅ **AMI-owned** | Entire file |
| File contains third-party copyright (Intel, Microsoft, EDK2, etc.) AND contains AMI override markers | ⚙️ **Third-party with AMI overrides** | AMI override sections only |
| File contains NO copyright header | ✅ **AMI-owned** (default assumption) | Entire file |
| File contains only third-party copyright, NO AMI override markers | ❌ **Third-party only** | Skip validation |

**AMI Override Marker Patterns (case-insensitive):**

Detect AMI-owned code sections in third-party files using these marker patterns:

| Start Marker | End Marker | Purpose |
|--------------|------------|---------|
| `// AMI OVERRIDE START` | `// AMI OVERRIDE END` | General EDK2/Intel overrides |
| `//APTIOV_SERVER_OVERRIDE_START:` | `//APTIOV_SERVER_OVERRIDE_END:` | Server platform overrides |
| `//APTIOV_SERVER_OVERRIDE_RC_START:` | `//APTIOV_SERVER_OVERRIDE_RC_END:` | Server platform RC overrides |
| Any marker matching: `//<PREFIX>OVERRIDE*START` where PREFIX contains "AMI" or "APTIOV" | Corresponding `END` marker | Project-specific AMI override tags |

**Detection Pattern:**
```regex
Start: ^\s*//\s*(AMI|APTIOV)[A-Z_]*OVERRIDE[A-Z_]*START
End:   ^\s*//\s*(AMI|APTIOV)[A-Z_]*OVERRIDE[A-Z_]*END
```

**Copyright Detection Patterns:**
- AMI: `Copyright (c) 1985-YYYY, AMI` or `Copyright.*AMI`
- Intel: `Copyright.*Intel Corporation`
- Microsoft: `Copyright.*Microsoft Corporation`
- EDK2/TianoCore: `Copyright.*TianoCore`

### Step 3: Extract AMI Code Sections

For each file, extract the relevant code based on classification:

**AMI-owned files (entire file validation):**
- Read full file content
- Validate all sections against AMI organization standards
- Apply all checks from Step 4

**Third-party files with AMI overrides (section-only validation):**
- Parse file line-by-line
- Extract ONLY lines between AMI override START/END markers (inclusive)
- Validate extracted sections only
- Report findings with original file line numbers
- Record: `[Third-party file — validating AMI override sections only]`

**Third-party files without AMI code:**
- Skip validation entirely
- Record: `[SKIP: Third-party file, no AMI code sections detected]`

**Examples:**

```c
// Intel copyright header
// ...
void IntelFunction() {
  // Skip this - third-party code
}

// AMI OVERRIDE START — Add custom validation
BOOLEAN gAmiCustomFlag = FALSE;  // ← Validate this (AMI code)

EFI_STATUS ValidateCustom() {   // ← Validate this (AMI code)
  return EFI_SUCCESS;
}
// AMI OVERRIDE END

void AnotherIntelFunction() {
  // Skip this - third-party code
}
```

### Step 4: Check Organization Standards

For each AMI code section (entire file OR extracted override blocks), verify:

1. **File Header Format** (AMI-owned files only)
   - AMI copyright banner present and current year (2026)
   - Doxygen `@file` block with brief description
   - Skip for third-party files with overrides (header is third-party)

2. **Source File Organization** (all AMI code)
   - Sections in correct order with `//------` separators (AMI files only)
   - Include order follows AMI pattern (when includes are in AMI section)

3. **Naming Conventions** (all AMI code) - MANDATORY
   - Functions: PascalCase
   - Entry points: `<Module>Init` pattern
   - Global variables: `g` prefix + PascalCase
   - Registration variables: `g<Name>Reg` pattern
   - Constants/Macros: ALL_CAPS
   - **No raw C types** (`int`, `char`, `void`) - **MANDATORY-MAJOR violation if present**

4. **INF File Structure** (AMI-owned INF files only)
   - Sections in AMI-specified order
   - `MdePkg/MdePkg.dec` listed first in `[Packages]`
   - Skip for third-party INF files

5. **AMI-Specific Patterns** (all AMI code)
   - SDL token usage
   - ELINK patterns (when modified)
   - Customization layer compliance

### Step 5: Report Findings

Append findings to the review report under a new section. Distinguish file classification in reporting:

```markdown
## AMI Module Developer's Guide Standards (MANDATORY)

Files validated against AMI Aptio 5.x Module Developer's Guide mandatory standards (`.github/skills/ami-module-developer-standards/`).

### Summary
- AMI-owned files validated: X
- Third-party files with AMI overrides validated: Y
- Third-party files skipped (no AMI code): Z

### Findings

**[AmiModulePkg/Nvram/NvramDxe.c]** (AMI-owned)
- File Header: Missing current year in copyright (2025 vs 2026)
  - Location: Line 3
  - Severity: **MANDATORY-MINOR** (impacts verdict score)
  - Fix: Update copyright year to 2026
- Raw C Type: `int` used instead of UEFI type
  - Location: Line 147
  - Severity: **MANDATORY-MAJOR** (blocking - ABI incompatibility risk)
  - Fix: Replace `int bufferSize` with `UINT32 BufferSize`

**[Intel/ClientOneSiliconPkg/Cpu/LibraryPrivate/PeiCpuPolicyLib/PeiCpuPolicyLib.c]** (Third-party with AMI overrides)
- [Third-party file — validating AMI override sections only: lines 245-260, 312-340]
- Naming Convention: Global variable missing `g` prefix
  - Location: Line 247 (inside `//APTIOV_SERVER_OVERRIDE_START:` block)
  - Severity: **MANDATORY-MINOR** (impacts verdict score)
  - Fix: Rename `AmiCustomBuffer` to `gAmiCustomBuffer`

**[Intel/ServerSiliconPkg/Mem/Library/MemRcLib/MemRc.c]** (Third-party only)
- [SKIP: Third-party file, no AMI code sections detected]

### Module Developer Standards Verdict
✅ **COMPLIANT** / ⚠️ **NON-COMPLIANT (impacts main verdict)**

**Severity Impact on Main Review Verdict:**
- **MANDATORY-MAJOR**: Added to main review MAJOR count → may trigger CONDITIONAL APPROVE or BLOCK
- **MANDATORY-MINOR**: Added to main review MINOR count → impacts score calculation
- **INFO**: Informational only, no verdict impact

> **Note:** Module Developer Guide violations are **MANDATORY** and affect the main review verdict (APPROVE/CONDITIONAL/BLOCK). All MANDATORY-MAJOR findings must be fixed before merge. MANDATORY-MINOR findings contribute to the overall quality score.
```

**Reporting Guidelines:**

1. **Group by file classification:**
   - AMI-owned files first
   - Third-party files with AMI overrides second
   - Skipped third-party files last

2. **For AMI override sections:**
   - Always include line range of override block in brackets: `[Third-party file — validating AMI override sections only: lines X-Y, Z-W]`
   - Report finding location as absolute line number in original file
   - Note which override block contains the finding

3. **For skipped files:**
   - Use single-line skip notation: `[SKIP: Third-party file, no AMI code sections detected]`
   - Do not open findings for pure third-party code

4. **If no findings:**
   - Write: `> All reviewed files comply with AMI organization coding standards.`
   - Still list skipped third-party files in summary

### Step 6: Impact on Main Review Verdict
- **DOES impact** the main review verdict (APPROVE/CONDITIONAL/BLOCK)
- Module Developer Guide violations are **MANDATORY**
- **MANDATORY-MAJOR** findings:
  - Added to main review MAJOR count
  - May change verdict from APPROVE → CONDITIONAL or BLOCK
  - Must be fixed before merge
- **MANDATORY-MINOR** findings:
  - Added to main review MINOR count
  - Contribute to quality score (affects verdict thresholds)
- **Verdict recalculation:** If new MAJOR findings trigger verdict change, update `Result.txt` and append note to main verdict section
- **AMI code only:** Only AMI-owned files and AMI override sections in third-party files are validated
- **Third-party code skipped:** Pure third-party code (Intel, EDK2, Microsoft) is not validated
- **Default assumption:** Files without copyright headers are treated as AMI-owned

## File Classification Examples

### Example 1: AMI-owned file
```c
//***********************************************************************
//*                                                                     *
//*                 Copyright (c) 1985-2026, AMI.                       *
//*                                                                     *
//***********************************************************************
/** @file NvramDxe.c
    NVRAM driver implementation
**/
```
**Classification:** ✅ AMI-owned → Validate entire file

### Example 2: Third-party with AMI overrides
```c
/** @file
  Copyright (c) 2020 - 2024, Intel Corporation. All rights reserved.
  SPDX-License-Identifier: BSD-2-Clause-Patent
**/

void IntelFunction() {
  // Third-party code - skip
}

// AMI OVERRIDE START — Add custom initialization
EFI_STATUS AmiCustomInit() {
  // AMI code - validate this section only
}
// AMI OVERRIDE END

void AnotherIntelFunction() {
  // Third-party code - skip
}
```
**Classification:** ⚙️ Third-party with AMI overrides → Validate override sections only (lines between START/END markers)

### Example 3: Third-party without AMI code
```c
/** @file
  Copyright (c) 2020 - 2024, Intel Corporation. All rights reserved.
  SPDX-License-Identifier: BSD-2-Clause-Patent
**/

void IntelFunction() {
  // No AMI override markers found
}
```
**Classification:** ❌ Third-party only → Skip validation

### Example 4: No copyright (assume AMI)
```c
#include <Uefi.h>

EFI_STATUS MyFunction() {
  // No copyright header found
}
```
**Classification:** ✅ AMI-owned (default) → Validate entire file

## Override Marker Variations

All these patterns are recognized as AMI override markers:

```c
// AMI OVERRIDE START
// AMI OVERRIDE START — Add validation
// AMI OVERRIDE START: Fix memory leak
//AMI OVERRIDE START
//  AMI OVERRIDE START  

//APTIOV_SERVER_OVERRIDE_START:
//APTIOV_SERVER_OVERRIDE_RC_START:
// APTIOV_SERVER_OVERRIDE_START: Description

// AMI_CUSTOM_OVERRIDE_START:
// AMI_PROJECT_OVERRIDE_START
```

**Detection is case-insensitive and whitespace-tolerant.**

## Severity Classification Guidelines

### MANDATORY-MAJOR (Blocking)
- Raw C types (`int`, `char`, `void`, `unsigned`) in UEFI code
- Missing AMI OVERRIDE markers in Intel/EDK2 file modifications
- Wrong customization layer (modifying Intel files without markers)
- Missing `g` prefix on global variables in security-critical code
- Entry point not following `<Module>Init` pattern

### MANDATORY-MINOR (Score Impact)
- Copyright year outdated
- Function naming case incorrect (non-PascalCase)
- File organization sections out of order
- Include order not following AMI pattern
- Missing `@file` Doxygen block
- INF section order incorrect

### INFO (Tracking Only)
- Suggestions for code clarity
- Optional improvements
- Style preferences

## Progressive Loading
The skill loads lightweight validation logic first, then references [Module_Developer_Standards.md](./Module_Developer_Standards.md) only when detailed standard text is needed for citation.
