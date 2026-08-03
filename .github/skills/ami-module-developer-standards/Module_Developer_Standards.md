# AMI Aptio 5.x Module Developer's Guide Standards (MANDATORY)

**Source:** AMI Aptio 5.x Module Developer's Guide  
**Compliance Level:** MANDATORY - Violations impact review verdict  
**Scope:** AMI-specific organization standards extending UEFI 2.10+, PI 1.8+, EDK II C Coding Standard 2.2+

---

## Violation Severity Levels

Module Developer Guide violations are classified by severity and impact the final review verdict:

| Severity | Impact on Verdict | Examples |
|----------|-------------------|----------|
| **MANDATORY-MAJOR** | Added to main review MAJOR count; may trigger CONDITIONAL APPROVE or BLOCK | Raw C types (`int`, `char`, `void`), missing AMI OVERRIDE markers in Intel/EDK2 files, wrong customization layer |
| **MANDATORY-MINOR** | Added to main review MINOR count; impacts quality score | Copyright year outdated, function naming case incorrect, section order wrong, include order violations |
| **INFO** | Informational only; no verdict impact | Suggestions for improvement, optional enhancements |

**Verdict Impact Rules:**
- MANDATORY-MAJOR findings are treated as MAJOR findings in the main review
- MANDATORY-MINOR findings are treated as MINOR findings in the main review
- Verdict is recalculated after Module Developer Guide validation
- If new findings push verdict from APPROVE → CONDITIONAL or BLOCK, `Result.txt` is updated

---

## Validation Scope: AMI Code Only (MANDATORY Compliance)

These standards are **MANDATORY** for AMI-owned code. Violations impact the final review verdict.

### File Classification

| File Type | How to Identify | Validation Scope |
|-----------|----------------|------------------|
| **AMI-owned** | Contains `Copyright (c) 1985-YYYY, AMI` | **Entire file** |
| **Third-party with AMI overrides** | Third-party copyright + AMI override markers | **AMI override sections only** |
| **No copyright** | No copyright header found | **Entire file** (default to AMI) |
| **Third-party only** | Third-party copyright, no AMI markers | **Skip validation** |

### AMI Override Markers in Third-Party Files

When AMI modifies third-party files (Intel, EDK2, etc.), changes are wrapped in override markers. **Only code between these markers is validated** against AMI organization standards.

**Standard Marker Patterns:**

| Start Marker | End Marker | Usage |
|--------------|------------|-------|
| `// AMI OVERRIDE START` | `// AMI OVERRIDE END` | General EDK2/Intel file modifications |
| `//APTIOV_SERVER_OVERRIDE_START:` | `//APTIOV_SERVER_OVERRIDE_END:` | Server platform overrides |
| `//APTIOV_SERVER_OVERRIDE_RC_START:` | `//APTIOV_SERVER_OVERRIDE_RC_END:` | Server platform RC overrides |

**Pattern Recognition (case-insensitive):**
```regex
Start: ^\s*//\s*(AMI|APTIOV)[A-Z_]*OVERRIDE[A-Z_]*START
End:   ^\s*//\s*(AMI|APTIOV)[A-Z_]*OVERRIDE[A-Z_]*END
```

**Example: Third-Party File with AMI Overrides**

```c
/** @file
  Copyright (c) 2020 - 2024, Intel Corporation. All rights reserved.
  SPDX-License-Identifier: BSD-2-Clause-Patent
**/

#include <Uefi.h>

// ⬇️ Third-party code - NOT validated against AMI standards
void IntelFunction() {
  int bufferSize = 100;  // Raw C types OK in Intel code
}

// ⬇️ AMI override section - VALIDATED against AMI standards
// AMI OVERRIDE START — Add custom validation
BOOLEAN gAmiValidationEnabled = TRUE;  // Must use UEFI types + 'g' prefix

EFI_STATUS AmiCustomValidation(VOID) {  // Must use PascalCase
  return EFI_SUCCESS;
}
// AMI OVERRIDE END
// ⬆️ End of AMI code

// ⬇️ Third-party code resumes - NOT validated
void AnotherIntelFunction() {
  // Intel code continues
}
```

**In this example:**
- Lines outside override markers: **Not validated** (Intel code)
- Lines between `// AMI OVERRIDE START` and `// AMI OVERRIDE END`: **Validated** against all applicable AMI standards (naming, types, patterns)
- File header (copyright): **Not validated** (remains Intel copyright)

---

## 1. File Header Format

**Applies to:** AMI-owned files only. Third-party files with AMI overrides keep their original header.

Every AMI source file (.c, .h) must use the AMI copyright banner followed by a Doxygen `@file` block:

```c
//***********************************************************************
//*                                                                     *
//*                 Copyright (c) 1985-20XX, AMI.                       *
//*                                                                     *
//*      All rights reserved. Subject to AMI licensing agreement.       *
//*                                                                     *
//***********************************************************************

/** @file ModuleName.c
    Brief description of the file's purpose
**/
```

### Requirements
- Copyright year must include current year (20XX updated annually) - **MANDATORY-MINOR** if outdated
- `@file` block must have file name matching actual file name - **MANDATORY-MINOR** if missing or incorrect
- Brief description must be present and meaningful (not "Module file") - **MANDATORY-MINOR** if generic

---

## 2. Source File Organization

Files are organized with `//------` separator lines into sections in this **strict order**:

### Section Order (Mandatory)

1. **Include(s)**
2. **Constant, Macro and Type Definition(s)**
   - Sub-groups: Constant, Macro, Type, Function Prototype
3. **Variable and External Declaration(s)**
   - Sub-groups: Variable, GUID, Protocol/PPI, External, Function definitions

### Example Structure

```c
//***********************************************************************
// Copyright & @file block
//***********************************************************************

//---------------------------------------------------------------------------
// Include(s)
//---------------------------------------------------------------------------
#include <Uefi.h>
#include <Token.h>
#include <AmiDxeLib.h>

//---------------------------------------------------------------------------
// Constant, Macro and Type Definition(s)
//---------------------------------------------------------------------------

// Constant Definition(s)
#define MAX_BUFFER_SIZE  256

// Macro Definition(s)
#define GET_ELEMENT(x)  ((x) & 0xFF)

// Type Definition(s)
typedef struct {
  UINT32  Field1;
  UINT16  Field2;
} MY_STRUCTURE;

// Function Prototype(s)
EFI_STATUS InitializeModule(VOID);

//---------------------------------------------------------------------------
// Variable and External Declaration(s)
//---------------------------------------------------------------------------

// Variable Declaration(s)
STATIC UINT8  mLocalBuffer[MAX_BUFFER_SIZE];

// GUID Definition(s)
EFI_GUID gMyProtocolGuid = MY_PROTOCOL_GUID;

// Protocol/PPI Declaration(s)
MY_PROTOCOL  *gMyProtocol = NULL;

// External Declaration(s)
extern UINT32  gExternalValue;

// Function Definition(s)
EFI_STATUS
InitializeModule (
  VOID
  )
{
  // Implementation
}
```

---

## 3. Naming Conventions

### Raw C Types (MANDATORY-MAJOR)

**NEVER use raw C types** — they cause ABI incompatibility, platform-dependent sizes, and runtime failures.

| ❌ Prohibited (Raw C) | ✅ Required (UEFI) | Reason |
|---------------------|-------------------|---------|
| `int` | `UINT32` or `INT32` | Size varies (16/32 bits) |
| `unsigned` | `UINT32` or `UINTN` | Platform-dependent |
| `char` | `CHAR8` | Sign varies by compiler |
| `void` | `VOID` | UEFI convention |
| `long` | `UINT64` or `INT64` | Size varies (32/64 bits) |
| `short` | `UINT16` or `INT16` | Not portable |

**Examples of MANDATORY-MAJOR violations:**
```c
// ❌ WRONG - Raw C types
int bufferSize = 100;
char name[64];
unsigned index;
void *ptr;
extern int VfrBin[];

// ✅ CORRECT - UEFI types
UINT32 BufferSize = 100;
CHAR8 Name[64];
UINTN Index;
VOID *Ptr;
extern UINT8 VfrBin[];
```

**Severity:** **MANDATORY-MAJOR** — Treated as MAJOR finding in main review; may trigger CONDITIONAL APPROVE or BLOCK verdict.

---

### Functions

| Pattern | Convention | Example |
|---------|-----------|---------|
| General functions | PascalCase | `InitializeDriver`, `ProcessBuffer` |
| Entry points | `<Module>Init` or `<Module>EntryPoint` | `CrbDxeInit`, `SmbiosPeiInit` |
| Static/local functions | PascalCase (prefix optional) | `ValidateInput`, `LocalHelper` |

### Variables

| Pattern | Convention | Example |
|---------|-----------|---------|
| Global variables | `g` prefix + PascalCase | `gBootScript`, `gAmiCrbInfoPpi` |
| Registration variables | `g<Name>Reg` | `gAmiConOutStartedProtocolReg` |
| Module-scope static | `m` prefix + PascalCase | `mLocalBuffer`, `mInitialized` |
| Local variables | camelCase or PascalCase | `BufferSize`, `status` |

### Constants and Macros

- ALL_CAPS with underscores: `MAX_BUFFER_SIZE`, `ENABLE_DEBUG_MODE`
- Token names in SDL: ALL_CAPS with underscores: `DEBUG_MODE`, `CRB_BOARD`

### Types

- UEFI types: `EFI_STATUS`, `VOID`, `UINT8`, `UINT16`, `UINT32`, `UINT64`, `UINTN`, `BOOLEAN`, `EFI_HANDLE`
- Custom types: PascalCase with all-caps suffix: `MY_PROTOCOL`, `SETUP_DATA`, `GPIO_CONFIG`
- Pointer types: use UEFI style: `EFI_HANDLE *Handle` (not `EFI_HANDLE* Handle`)

---

## 4. Include Order

Includes must follow this order:

```c
#include <Uefi.h>       // or <Pei.h> for PEI modules - FIRST
#include <Token.h>       // auto-generated SDL token definitions
#include <AmiDxeLib.h>   // AMI DXE library (or <AmiPeiLib.h> for PEI)
#include <Library/PcdLib.h>       // EDK2 standard libraries
#include <Library/BaseMemoryLib.h>
#include <Protocol/SomeProtocol.h> // Protocol / PPI headers
#include <SetupVariable.h>         // Platform-specific headers
```

### Rules
1. **Phase header first:** `<Uefi.h>` or `<Pei.h>` or `<Base.h>`
2. **AMI headers next:** `<Token.h>`, `<AmiDxeLib.h>` / `<AmiPeiLib.h>`
3. **EDK2 libraries:** `<Library/...>`
4. **Protocol/PPI/GUID headers:** `<Protocol/...>`, `<Ppi/...>`, `<Guid/...>`
5. **Platform headers last:** Setup, board-specific

---

## 5. INF File Structure

INF file sections must appear in this order:

```ini
[Defines]
  INF_VERSION                    = 0x00010005
  BASE_NAME                      = ModuleName
  FILE_GUID                      = XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
  MODULE_TYPE                    = DXE_DRIVER
  VERSION_STRING                 = 1.0
  ENTRY_POINT                    = ModuleInit

[Sources]
  ModuleFile.c
  ModuleHeader.h

[Packages]
  MdePkg/MdePkg.dec              # MUST be first
  AmiModulePkg/AmiModulePkg.dec
  AmiChipsetModulePkg/AmiChipsetModulePkg.dec

[LibraryClasses]
  UefiDriverEntryPoint           # Entry point library
  UefiBootServicesTableLib
  BaseMemoryLib

[Protocols]
  gEfiSomeProtocolGuid           # PRODUCED
  gEfiOtherProtocolGuid          # CONSUMED

[Guids]
  gEfiEventGroupGuid

[Pcd]
  gEfiMdePkgTokenSpaceGuid.PcdSomeValue

[Depex]
  gEfiSomeProtocolGuid AND gEfiOtherProtocolGuid
```

### Requirements
- `MdePkg/MdePkg.dec` must be **first** in `[Packages]` - **MANDATORY-MINOR** if not first
- Entry-point library must be **first** in `[LibraryClasses]` - **MANDATORY-MINOR** if not first
- Section order must match above - **MANDATORY-MINOR** if out of order
- Comment PRODUCED vs CONSUMED for protocols/PPIs when not obvious

---

## 6. AMI Override Marker Policy

`// AMI OVERRIDE START/END` markers are **required only** when modifying EDK2 or Intel-owned files. They are **never** used in AMI-owned packages.

### When Markers are Required

| Package path | Markers required? | Violation if missing |
|---|---|---|
| `Intel/` (any Intel package) | ✅ **YES** | **MANDATORY-MAJOR** |
| `MdePkg/`, `MdeModulePkg/`, `SecurityPkg/`, `CryptoPkg/`, `UefiCpuPkg/` | ✅ **YES** | **MANDATORY-MAJOR** |
| `Ami*Pkg/`, `CrbPkg/`, `AmiCrbPkg/`, vendor packages | ❌ **NO** | N/A |

### Syntax (EDK2 / Intel files only)

```c
// AMI OVERRIDE START — <brief description> (<YYYY-MM-DD>)
... changed code ...
// AMI OVERRIDE END
```

**Example:**
```c
// AMI OVERRIDE START — Add SMRAM boundary validation (2026-05-15)
if (Address < mSmramBase || Address > mSmramEnd) {
  return EFI_ACCESS_DENIED;
}
// AMI OVERRIDE END
```

---

## 7. SDL Token Patterns

### Token Declaration

```sdl
TOKEN
    Name  = "MY_FEATURE_ENABLE"
    Value  = "1"
    Help  = "Enable my feature support"
    TokenType = Boolean
    TargetMAK = Yes
    TargetH = Yes
End
```

### Token Override (Higher Layer)

```sdl
TOKEN
    Name  = "MY_FEATURE_ENABLE"
    Value  = "0"
    TokenType = Boolean
    TargetMAK = Yes
    TargetH = Yes
End
```

### PCD Mapping

```sdl
PcdMapping
    Name  = "PcdMyValue"
    GuidSpace  = "gMyTokenSpaceGuid"
    PcdType  = "PcdsFixedAtBuild"
    DataType  = "Uint32"
    Value  = "$(MY_TOKEN_VALUE)"
    TargetDSC = Yes
End
```

---

## 8. ELINK Patterns

### ELINK Chain Root (Owning Module)

```sdl
ELINK
    Name  = "MyHandlerList"
    InvokeOrder = ReplaceParent
End
```

### ELINK Registration (Contributor)

```sdl
ELINK
    Name  = "MyHookFunction,"          # Note trailing comma
    Parent  = "MyHandlerList"
    InvokeOrder = AfterParent
End
```

### Function Typedef (Owning Module Header)

```c
typedef VOID (MY_HANDLER_HOOK) (UINT8 Data, UINT64 Parameter);
```

### Consumption (Owning Module .c)

```c
#include <MyModuleELinks.h>

extern MY_HANDLER_HOOK MY_HANDLER_LIST EndOfList;
MY_HANDLER_HOOK* MyHandlers[] = {MY_HANDLER_LIST NULL};
```

---

## 9. Customization Layers

Changes should target the **outermost applicable layer**:

```
┌─────────────────────────────────────────────────┐
│  <project>.sdl           (project overrides)    │
├─────────────────────────────────────────────────┤
│  <VendorPkg>/            (vendor/OEM custom)    │
├─────────────────────────────────────────────────┤
│  CrbPkg/ or AmiCrbPkg/   (board reference)      │
├─────────────────────────────────────────────────┤
│  AmiModulePkg/           (AMI core - modify OK) │
├─────────────────────────────────────────────────┤
│  Intel/                  (use AMI OVERRIDE)     │
├─────────────────────────────────────────────────┤
│  MdePkg / MdeModulePkg   (use AMI OVERRIDE)     │
└─────────────────────────────────────────────────┘
```

### Rules
- Prefer SDL token overrides over code patches
- Use ELINK hooks instead of modifying original module source
- Vendor package customizations override CRB package
- Never modify `Build/` or `Conf/` files (auto-generated)

---

## 10. Module Type Specific Patterns

### PEI Module Entry Point

```c
EFI_STATUS
EFIAPI
MyPeiInit (
  IN       EFI_PEI_FILE_HANDLE  FileHandle,
  IN CONST EFI_PEI_SERVICES     **PeiServices
  )
```

### DXE Driver Entry Point

```c
EFI_STATUS
EFIAPI
MyDxeInit (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
```

### SMM Driver Entry Point

```c
EFI_STATUS
EFIAPI
MySmmInit (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
```

---

## 11. Common AMI-Specific Patterns

### Setup Variable Access

```c
#include <SetupVariable.h>

SETUP_DATA  SetupData;
UINTN       VariableSize = sizeof(SETUP_DATA);

Status = pRS->GetVariable(
           L"Setup",
           &gSetupGuid,
           NULL,
           &VariableSize,
           &SetupData
           );
```

### Boot Script Saving

```c
#include <AmiCspLib.h>

BOOT_SCRIPT_S3_IO_WRITE_MACRO(
  gBootScript,
  EfiBootScriptWidthUint32,
  IoAddress,
  1,
  &Value
  );
```

### NVRAM Read/Write

```c
#include <AmiDxeLib.h>

Status = pRS->SetVariable(
           L"MyVariable",
           &gMyVariableGuid,
           EFI_VARIABLE_NON_VOLATILE | EFI_VARIABLE_BOOTSERVICE_ACCESS,
           sizeof(MyData),
           &MyData
           );
```

---

## Validation Checklist

When reviewing code for AMI organization standards compliance:

☐ **File Header**
  - [ ] AMI copyright banner present
  - [ ] Current year in copyright
  - [ ] `@file` block with correct filename and description

☐ **File Organization**
  - [ ] Sections in correct order (Include, Constant/Macro/Type, Variable/External)
  - [ ] `//------` separators present
  - [ ] Include order follows AMI pattern

☐ **Naming**
  - [ ] Functions use PascalCase
  - [ ] Entry points use `<Module>Init` pattern
  - [ ] Global variables use `g` prefix
  - [ ] Constants use ALL_CAPS
  - [ ] No raw C types (`int`, `char`, `void`)

☐ **INF Structure**
  - [ ] Sections in correct order
  - [ ] `MdePkg/MdePkg.dec` first in `[Packages]`
  - [ ] Entry-point library first in `[LibraryClasses]`

☐ **Customization Layer**
  - [ ] Changes in appropriate layer (outermost)
  - [ ] AMI OVERRIDE markers used correctly (Intel/EDK2 only)
  - [ ] SDL tokens preferred over code patches

☐ **AMI Patterns**
  - [ ] ELINK registrations have trailing comma
  - [ ] Setup variable access uses proper pattern
  - [ ] Boot script macros used correctly

---

## Reference

**Document:** AMI Aptio 5.x Module Developer's Guide  
**Path:** `C:\Users\saimanojn\Downloads\AMI_Aptio_5.x_Module_Developer's_Guide_INT 1.doc`  
**Workspace Instructions:** `.github/copilot-instructions.md`

For UEFI/PI/EDK2 spec compliance, refer to main review stages — this document covers **AMI-specific organization standards only**.
