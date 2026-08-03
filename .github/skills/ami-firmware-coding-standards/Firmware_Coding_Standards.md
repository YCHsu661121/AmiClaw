# AMI Aptio 5.x Firmware Coding Standards (INFORMATIONAL)

**Source:** AMI Aptio 5.x Firmware Coding Standards  
**Compliance Level:** INFORMATIONAL - Style recommendations only  
**Scope:** Firmware-specific style guidance extending Module Developer's Guide

---

## Validation Scope: AMI Code Only (INFORMATIONAL)

These standards are **INFORMATIONAL** style recommendations for AMI-owned code. Violations do NOT impact the final review verdict.

### Relationship to Module Developer's Guide

| Standard | Compliance Level | Impact |
|----------|------------------|--------|
| **Module Developer's Guide** | MANDATORY | Violations impact verdict (MAJOR/MINOR) |
| **Firmware Coding Standards** (this document) | INFORMATIONAL | Violations tracked for post-merge improvement |

**All Firmware Coding Standards findings use INFO severity.**

---

## 1. Comment Style and Documentation

### Function Header Comments

**Guideline:** All functions should have complete Doxygen-style header comments.

```c
/**
  Initialize the NVRAM driver.

  This function performs the following:
  - Allocates NVRAM buffers
  - Registers variable services protocol
  - Installs NVRAM access protocol

  @param[in]  ImageHandle   The firmware allocated handle for the EFI image
  @param[in]  SystemTable   A pointer to the EFI System Table

  @retval EFI_SUCCESS       NVRAM initialized successfully
  @retval EFI_OUT_OF_RESOURCES  Failed to allocate buffers
  @retval EFI_DEVICE_ERROR  NVRAM hardware error

**/
EFI_STATUS
EFIAPI
NvramDxeInit (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
```

**Observations (INFO severity):**
- Missing `@param` tags
- Missing `@retval` descriptions
- Missing function purpose description
- Missing detailed behavior notes

### Inline Comments

**Guideline:** Complex logic should have explanatory comments.

✅ **Good:**
```c
// Check if variable is authenticated before allowing delete
if (!(Attributes & EFI_VARIABLE_AUTHENTICATED_WRITE_ACCESS)) {
  return EFI_SECURITY_VIOLATION;
}
```

⚠️ **Needs Improvement:**
```c
// Check flags
if (!(Attr & 0x20)) {  // INFO: Magic number, unclear purpose
  return EFI_SECURITY_VIOLATION;
}
```

### TODO/FIXME/HACK Markers

**Guideline:** Use standardized markers for known issues.

```c
// TODO: Optimize buffer allocation for S3 path
// FIXME: Race condition when multiple threads access the variable
// HACK: Temporary workaround for silicon errata, remove in next release
```

---

## 2. Source File Structure

### C File Organization

**Guideline:** C source files must follow this strict order:

1. **File Header** (copyright + `@file` block)
2. **Include Statements** (grouped and ordered)
3. **Constants, Macros, and Type Definitions**
4. **Variable and External Declarations**
5. **Function Definitions**

**Rules:**
- Function prototypes/declarations must appear before function definitions
- Group related declarations together
- No mixed ordering (e.g., function definition → variable → function definition)
- Function definitions should appear in logical order (initialization → helpers → main logic)

✅ **Good Structure:**
```c
//***********************************************************************
// File Header
//***********************************************************************

// Include(s)
#include <Uefi.h>
#include <Library/BaseLib.h>

// Constant Definition(s)
#define MAX_SIZE  256

// Type Definition(s)
typedef struct {
  UINT32  Value;
} MY_STRUCT;

// Function Prototype(s)
EFI_STATUS HelperFunction(VOID);
EFI_STATUS MainFunction(VOID);

// Variable Declaration(s)
STATIC UINT32  mCounter = 0;

// Function Definition(s)
EFI_STATUS
HelperFunction (
  VOID
  )
{
  // Implementation
}

EFI_STATUS
MainFunction (
  VOID
  )
{
  // Implementation
}
```

⚠️ **Poor Structure (INFO):**
```c
// Function definition before declaration
EFI_STATUS SomeFunction(VOID) { ... }  // INFO: Declare before define

// Variable after function
STATIC UINT32 mVar;  // INFO: Variables should come before functions

// Another function
EFI_STATUS AnotherFunction(VOID) { ... }
```

**Observations (INFO severity):**
- Mixed ordering of declarations and definitions
- Function definitions before declarations
- Variables scattered throughout file
- Related functions not grouped

---

## 3. Header File Rules

### No Code in Headers

**Guideline:** Header files (`.h`) must contain ONLY declarations, never code implementations.

❌ **Prohibited in Headers:**
```c
// MyHeader.h
void MyFunction() {  // INFO: Function definition in header
  DoSomething();
}

STATIC UINT32 mVariable = 0;  // INFO: Variable definition in header
```

✅ **Correct:**
```c
// MyHeader.h
void MyFunction(VOID);  // Declaration only

extern UINT32 mVariable;  // External declaration
```

### Include Guards

**Guideline:** All header files must use include guards.

✅ **Required Pattern:**
```c
#ifndef _MY_HEADER_H_
#define _MY_HEADER_H_

// Header content

#endif  // _MY_HEADER_H_
```

**Observations (INFO severity):**
- Missing include guards
- Incorrect guard naming (should match filename)
- Missing closing `#endif` comment

### Self-Contained Headers

**Guideline:** Headers should be self-contained and include all dependencies.

✅ **Good:**
```c
// MyProtocol.h
#include <Uefi.h>  // Needed for EFI_STATUS

EFI_STATUS InstallMyProtocol(VOID);
```

⚠️ **Needs Improvement:**
```c
// MyProtocol.h
EFI_STATUS InstallMyProtocol(VOID);  // INFO: Missing <Uefi.h> for EFI_STATUS
```

### Minimize Header Includes

**Guideline:** Include only what is directly needed in the header.

- Avoid including headers that are only needed by the `.c` implementation
- Use forward declarations when possible
- Separate public vs private definitions (use separate headers if needed)

✅ **Good:**
```c
// MyPublic.h - Public interface
typedef struct _MY_PROTOCOL MY_PROTOCOL;  // Forward declaration

EFI_STATUS InstallProtocol(MY_PROTOCOL *Protocol);
```

---

## 4. Source Line Formatting

### One Statement Per Line

**Guideline:** Each statement should be on its own line.

❌ **Avoid:**
```c
Status = Init(); if (EFI_ERROR(Status)) return Status;  // INFO: Split into multiple lines
```

✅ **Good:**
```c
Status = Init();
if (EFI_ERROR(Status)) {
  return Status;
}
```

### Operator Spacing

**Guideline:** Consistent spacing around operators improves readability.

✅ **Good Spacing:**
```c
Result = Value1 + Value2;       // Space around binary operators
Pointer->Member;                // No space around ->
Structure.Field;                // No space around .
Array[Index];                   // No space before [
Function(Arg1, Arg2);           // Space after comma
for (i = 0; i < Max; i++);      // Space after semicolon
```

⚠️ **Inconsistent (INFO):**
```c
Result=Value1+Value2;           // INFO: Add spaces
Pointer -> Member;              // INFO: Remove spaces
Function(Arg1,Arg2);            // INFO: Add space after comma
```

### Variable Declarations

**Guideline:** One variable per line (except related simple variables).

✅ **Preferred:**
```c
UINT32  BufferSize;
UINT32  MaxSize;
UINT8   *Buffer;
```

⚠️ **Avoid:**
```c
UINT32 BufferSize, MaxSize, *Pointer;  // INFO: Split into separate lines
```

**Observations (INFO severity):**
- Multiple variables declared on one line
- Inconsistent spacing in declarations
- Mixed types on same line

---

## 5. Naming Quality

### Meaningful Names

**Guideline:** Use descriptive, unambiguous names that convey purpose.

❌ **Avoid Ambiguous Names:**
```c
UINT32  Size1, Size2;           // INFO: What do these sizes represent?
UINT32  Var1, Var2, Var3;       // INFO: Non-descriptive
UINT32  Temp, Tmp, T;           // INFO: Overly abbreviated
```

✅ **Better:**
```c
UINT32  InputBufferSize;
UINT32  OutputBufferSize;
UINT32  MaxTransferSize;
```

### Avoid Similar Names

**Guideline:** Prevent confusion from similar-looking identifiers.

⚠️ **Confusing (INFO):**
```c
UINT32  BufferSize;             // Lower camel case
UINT32  buffersize;             // All lowercase - INFO: Too similar
UINT32  BUFFERSIZE;             // All caps - INFO: Case-only difference
UINT32  Buffer_Size;            // Underscore variant - INFO: Inconsistent
```

**Observations (INFO severity):**
- Case-only differences between identifiers
- Similar names with minor variations
- Single-letter differences (e.g., `DataPtr` vs `DataPrt`)

### Appropriate Abbreviations

**Guideline:** Use well-known abbreviations; avoid cryptic short forms.

✅ **Acceptable Abbreviations:**
- `Max`, `Min`, `Num`, `Ptr`, `Addr`, `Len`, `Idx`
- `Init`, `Cfg`, `Tmp`, `Mgr`, `Ctrl`

⚠️ **Overly Abbreviated (INFO):**
```c
UINT32  BufSz;                  // INFO: Use BufferSize
UINT32  NmElmnts;               // INFO: Use NumElements
EFI_STATUS  Sts;                // INFO: Use Status
```

**Observations (INFO severity):**
- Unclear abbreviations
- Inconsistent abbreviation style within same file
- Names too short to be meaningful

---

## 6. Third-Party Code Modification (Porting Markers)

### AMI Porting Markers - REQUIRED

**Guideline:** ALL modifications to third-party or EDK2 code MUST be wrapped with AMI porting markers.

**Required Pattern:**
```c
//*** AMI PORTING BEGIN ***
// Modified code here
//*** AMI PORTING END ***
```

**Applies to:**
- EDK2 packages (`MdePkg`, `MdeModulePkg`, `SecurityPkg`, `CryptoPkg`, `UefiCpuPkg`)
- Intel packages (`Intel/`)
- Any third-party code not owned by AMI

✅ **Correct Usage:**
```c
// Original Intel/EDK2 code
void OriginalFunction()
{
  // Original implementation
  
  //*** AMI PORTING BEGIN ***
  // AMI-specific validation added
  if (!ValidateAmiRequirement()) {
    return EFI_SECURITY_VIOLATION;
  }
  //*** AMI PORTING END ***
  
  // Rest of original code
}
```

❌ **Missing Markers (INFO):**
```c
// Modified third-party code without markers
void ThirdPartyFunction()
{
  // Original code
  CustomAmiFunction();  // INFO: AMI modification not marked
  // Original code
}
```

### Marker Placement Rules

1. **Wrap only AMI changes** - Do not include original code inside markers
2. **One marker pair per change** - Separate distinct modifications
3. **Add brief description** - Explain why modification was needed
4. **Keep markers minimal** - Only changed lines, not entire functions

✅ **Good:**
```c
Status = AllocateBuffer();
if (EFI_ERROR(Status)) {
  //*** AMI PORTING BEGIN ***
  // Added logging for debug tracking
  DEBUG((DEBUG_ERROR, "[AMI] Buffer allocation failed: %r\n", Status));
  //*** AMI PORTING END ***
  return Status;
}
```

### Alternative Marker Names

These are also acceptable (project-specific):
- `//*** AMI PORTING BEGIN ***` / `//*** AMI PORTING END ***` (preferred)
- `// AMI OVERRIDE START` / `// AMI OVERRIDE END`
- `//APTIOV_SERVER_OVERRIDE_START:` / `//APTIOV_SERVER_OVERRIDE_END:`

**Observation (INFO severity):**
- Modifications to third-party code without porting markers
- Incorrect marker syntax
- Missing explanation in marker comments
- Markers wrapping too much unmodified code

---

## 7. Code Readability

### Line Length

**Guideline:** Prefer lines under 120 characters.

**Observation:** Lines exceeding 120 characters reduce readability (INFO severity).

✅ **Good:**
```c
Status = gBS->InstallMultipleProtocolInterfaces(
                &Handle,
                &gEfiNvramAccessProtocolGuid,
                &mNvramAccessProtocol,
                NULL
                );
```

⚠️ **Consider Refactoring:**
```c
Status = gBS->InstallMultipleProtocolInterfaces(&Handle, &gEfiNvramAccessProtocolGuid, &mNvramAccessProtocol, &gEfiNvramControlProtocolGuid, &mNvramControlProtocol, NULL);  // INFO: Line too long
```

### Function Length

**Guideline:** Functions should be under 200 lines.

**Observation:** Functions exceeding 200 lines suggest refactoring opportunities (INFO severity).

**Suggestion:** Break into smaller, focused functions:
- Extract complex logic into helper functions
- Separate initialization from processing
- Create subfunctions for error handling paths

### Nesting Depth

**Guideline:** Prefer nesting depth under 5 levels.

⚠️ **Deep Nesting (INFO):**
```c
if (Condition1) {
  if (Condition2) {
    if (Condition3) {
      if (Condition4) {
        if (Condition5) {
          // INFO: Consider refactoring (5+ levels deep)
        }
      }
    }
  }
}
```

✅ **Better - Early Returns:**
```c
if (!Condition1) return EFI_INVALID_PARAMETER;
if (!Condition2) return EFI_NOT_READY;
if (!Condition3) return EFI_DEVICE_ERROR;
if (!Condition4) return EFI_ACCESS_DENIED;
// Actual logic at minimal nesting
```

### Variable Scope Minimization

**Guideline:** Declare variables in the smallest scope possible.

✅ **Good:**
```c
EFI_STATUS MyFunction(VOID)
{
  EFI_STATUS  Status;
  
  // ... some code ...
  
  {
    UINT32  TempValue;  // Scoped to this block only
    TempValue = CalculateSomething();
    Status = ProcessValue(TempValue);
  }
  
  return Status;
}
```

---

## 8. Error Handling Patterns

### Consistent Error Handling

**Guideline:** Use consistent error handling patterns throughout a module.

✅ **Consistent Pattern:**
```c
Status = Step1();
if (EFI_ERROR(Status)) {
  DEBUG((DEBUG_ERROR, "Step1 failed: %r\n", Status));
  goto Exit;
}

Status = Step2();
if (EFI_ERROR(Status)) {
  DEBUG((DEBUG_ERROR, "Step2 failed: %r\n", Status));
  goto Exit;
}

Exit:
  // Cleanup
  return Status;
```

### Resource Cleanup

**Guideline:** Always clean up resources in error paths.

✅ **Good - Cleanup on Error:**
```c
Buffer = AllocatePool(Size);
if (Buffer == NULL) {
  return EFI_OUT_OF_RESOURCES;
}

Status = ProcessBuffer(Buffer);
if (EFI_ERROR(Status)) {
  FreePool(Buffer);  // Cleanup before return
  return Status;
}

FreePool(Buffer);
return EFI_SUCCESS;
```

### Error Message Clarity

**Guideline:** Debug messages should clearly identify the error source.

✅ **Good:**
```c
DEBUG((DEBUG_ERROR, "[NVRAM] Failed to allocate buffer (Size=%d): %r\n", BufferSize, Status));
```

⚠️ **Needs Improvement:**
```c
DEBUG((DEBUG_ERROR, "Error: %r\n", Status));  // INFO: Add context (module, operation)
```

---

## 9. Performance Considerations

### Unnecessary Memory Allocations

**Guideline:** Avoid allocations in performance-critical paths.

⚠️ **Optimization Opportunity (INFO):**
```c
for (Index = 0; Index < Count; Index++) {
  Buffer = AllocatePool(Size);  // INFO: Consider allocating once before loop
  ProcessBuffer(Buffer);
  FreePool(Buffer);
}
```

✅ **Better:**
```c
Buffer = AllocatePool(Size);
for (Index = 0; Index < Count; Index++) {
  ProcessBuffer(Buffer);
}
FreePool(Buffer);
```

### Repeated Calculations

**Guideline:** Cache calculated values instead of recalculating.

⚠️ **Repeated Calculation (INFO):**
```c
for (Index = 0; Index < Count; Index++) {
  Process(Data[Index] * sizeof(ELEMENT_TYPE));  // INFO: Calculate once
}
```

✅ **Better:**
```c
ElementSize = sizeof(ELEMENT_TYPE);
for (Index = 0; Index < Count; Index++) {
  Process(Data[Index] * ElementSize);
}
```

### String Operations in Loops

**Guideline:** Minimize string operations in tight loops.

⚠️ **Performance Note (INFO):**
```c
for (Index = 0; Index < Count; Index++) {
  StrCpy(Buffer, L"Prefix");  // INFO: Move string ops outside loop if possible
  StrCat(Buffer, Names[Index]);
  ProcessString(Buffer);
}
```

---

## 10. Maintainability

### Code Duplication

**Guideline:** Extract common code into reusable functions.

⚠️ **Duplication Detected (INFO):**
```c
// In Function1:
Status = ValidateInput(Input);
if (EFI_ERROR(Status)) {
  DEBUG((DEBUG_ERROR, "Invalid input: %r\n", Status));
  return Status;
}

// In Function2:
Status = ValidateInput(Input);  // INFO: Extract to helper function
if (EFI_ERROR(Status)) {
  DEBUG((DEBUG_ERROR, "Invalid input: %r\n", Status));
  return Status;
}
```

### Magic Numbers

**Guideline:** Replace magic numbers with named constants.

⚠️ **Magic Number (INFO):**
```c
if (Size > 0x10000) {  // INFO: Use named constant
  return EFI_BUFFER_TOO_SMALL;
}
```

✅ **Better:**
```c
#define MAX_BUFFER_SIZE  0x10000  // 64 KB

if (Size > MAX_BUFFER_SIZE) {
  return EFI_BUFFER_TOO_SMALL;
}
```

### Complex Boolean Expressions

**Guideline:** Simplify complex conditions for clarity.

⚠️ **Complex Expression (INFO):**
```c
if ((Flags & FLAG_A) && (Flags & FLAG_B) && !(Flags & FLAG_C) && 
    (Status == EFI_SUCCESS || Status == EFI_WARN_RESET_REQUIRED)) {
  // INFO: Consider extracting to named boolean or helper function
}
```

✅ **Better:**
```c
BOOLEAN IsValidState(UINT32 Flags, EFI_STATUS Status)
{
  if (!(Flags & FLAG_A) || !(Flags & FLAG_B)) return FALSE;
  if (Flags & FLAG_C) return FALSE;
  if (Status != EFI_SUCCESS && Status != EFI_WARN_RESET_REQUIRED) return FALSE;
  return TRUE;
}

if (IsValidState(Flags, Status)) {
  // Clear logic
}
```

---

## 11. Firmware-Specific Patterns

### Boot Path Optimization

**Guideline:** Optimize boot path for minimal delay.

**Observations (INFO):**
- Defer non-critical initialization to later boot phases
- Minimize PEI phase memory allocations
- Avoid unnecessary protocol installs in early boot
- Cache frequently accessed data

**Example:**
```c
// INFO: Consider deferring feature init to BDS phase
if (IsBootPhase(DXE_CORE)) {
  // Defer non-critical features
  RegisterProtocolNotify(&gEfiBdsArchProtocolGuid, DeferredInit);
} else {
  // Critical path only
  InitializeCriticalHardware();
}
```

### Memory Footprint

**Guideline:** Minimize memory usage, especially in PEI.

**Observations (INFO):**
- Large static arrays suggest pool allocation
- Temporary buffers should be freed promptly
- Consider pool vs page allocation based on size
- PEI HOBs should be minimal

**Example:**
```c
// INFO: Large array increases footprint
STATIC UINT8 mLargeBuffer[64 * 1024];  // 64KB static allocation

// Consider:
UINT8  *Buffer = AllocatePool(RequiredSize);  // Allocate only what's needed
```

### S3 Resume Path Safety

**Guideline:** Ensure S3 resume path uses only S3-safe resources.

**Observations (INFO):**
- No runtime variable access in S3 path (use boot script)
- No protocol dependencies in S3 resume
- Hardware state must be restored from saved boot script
- SMM handlers must be S3-aware

**Example:**
```c
// INFO: Variable access not S3-safe
if (IsS3Resume()) {
  // Use boot script data, not fresh variable reads
  RestoreFromBootScript();
} else {
  GetVariable(L"Config", ...);
}
```

---

## 12. Additional Style Recommendations

### Whitespace

**Guideline:** Consistent whitespace improves readability.

- Blank line between function definitions
- Blank line between logical code blocks
- Space after keywords: `if (`, `while (`, `for (`
- No trailing whitespace

### Bracket Style

**Guideline:** Follow consistent bracket placement.

✅ **Preferred (UEFI Style):**
```c
if (Condition)
{
  // Code
}
```

**Acceptable:**
```c
if (Condition) {
  // Code
}
```

**Choose one and be consistent within a file.**

### Typedef vs Struct

**Guideline:** Use typedefs for complex structures.

✅ **Good:**
```c
typedef struct {
  UINT32  Field1;
  UINT16  Field2;
} MY_STRUCTURE;

MY_STRUCTURE  MyVar;  // Clean usage
```

---

## Validation Checklist (All INFO Severity)

When reviewing for Firmware Coding Standards:

☐ **Comments**
  - [ ] Function headers complete with @param/@retval
  - [ ] Complex logic has explanatory comments
  - [ ] TODO/FIXME properly marked

☐ **File Structure**
  - [ ] C files follow correct order (header → includes → constants → variables → functions)
  - [ ] Function declarations before definitions
  - [ ] No mixed ordering of sections
  - [ ] Related declarations grouped together

☐ **Header Files**
  - [ ] No code implementations in headers (declarations only)
  - [ ] Include guards present and correctly named
  - [ ] Headers are self-contained
  - [ ] Unnecessary includes minimized

☐ **Line Formatting**
  - [ ] One statement per line
  - [ ] Consistent operator spacing
  - [ ] One variable per line (exceptions for related simple vars)
  - [ ] No trailing whitespace

☐ **Naming Quality**
  - [ ] Names are meaningful and descriptive
  - [ ] No ambiguous names (Size1, Var2, etc.)
  - [ ] No case-only name differences
  - [ ] Abbreviations are clear and consistent

☐ **Porting Markers**
  - [ ] AMI modifications to third-party code wrapped with `//*** AMI PORTING BEGIN/END ***`
  - [ ] Markers include brief explanation
  - [ ] Only changed code inside markers
  - [ ] Correct syntax used

☐ **Readability**
  - [ ] Lines under 120 characters (where reasonable)
  - [ ] Functions under 200 lines
  - [ ] Nesting depth under 5 levels
  - [ ] Variables scoped minimally

☐ **Error Handling**
  - [ ] Consistent error handling pattern
  - [ ] All error paths clean up resources
  - [ ] Error messages are clear and specific

☐ **Performance**
  - [ ] No unnecessary allocations in loops
  - [ ] Calculations cached when repeated
  - [ ] String operations minimized in tight loops

☐ **Maintainability**
  - [ ] No significant code duplication
  - [ ] Magic numbers replaced with constants
  - [ ] Complex expressions simplified

☐ **Firmware-Specific**
  - [ ] Boot path optimized (deferred initialization)
  - [ ] Memory footprint considered
  - [ ] S3 resume path uses safe resources only

---

## Reference

**Document:** AMI Aptio 5.x Firmware Coding Standards  
**Workspace Instructions:** `.github/copilot-instructions.md`

**Related Standards:**
- Module Developer's Guide (MANDATORY) - `.github/skills/ami-module-developer-standards/`
- UEFI/PI/EDK2 specs - covered in main review stages

This document covers **firmware-specific style recommendations only** - all findings are informational and do not impact review verdict.
