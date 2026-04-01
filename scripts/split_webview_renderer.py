"""
Sonnet refactor script: Extract getHtmlForWebview from ollama-chat.ts
into src/webview/WebviewRenderer.ts

Priority-1 split: pure HTML/CSS/JS, no side-effects, zero class coupling.
Run via: docker compose run --rm npm run split:webview
Or:       docker run --rm -v $PWD:/workspace -w /workspace python:3.12-slim python scripts/split_webview_renderer.py
"""

import os
import re

SRC = "src/ollama-chat.ts"
RENDERER = "src/webview/WebviewRenderer.ts"

def main():
    with open(SRC, encoding="utf-8") as f:
        lines = f.readlines()  # preserves \n

    total = len(lines)
    print(f"  Source: {total} lines")

    # Find getHtmlForWebview start (1-indexed search, store 0-indexed)
    start_idx = None
    for i, line in enumerate(lines):
        if re.search(r"\s*private getHtmlForWebview\(_webview", line):
            start_idx = i
            break
    if start_idx is None:
        raise RuntimeError("getHtmlForWebview not found")

    # Find its closing brace: scan forward, track brace depth
    depth = 0
    end_idx = None
    for i in range(start_idx, total):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0:
            end_idx = i
            break
    if end_idx is None:
        raise RuntimeError("Could not find closing brace of getHtmlForWebview")

    print(f"  getHtmlForWebview: lines {start_idx+1}–{end_idx+1} ({end_idx-start_idx+1} lines)")

    # ── 1. Build WebviewRenderer.ts ──────────────────────────────────────────
    # Extract inner body (skip method signature line, replace with export func sig)
    inner_body = lines[start_idx + 1 : end_idx]  # everything except first & last lines

    os.makedirs("src/webview", exist_ok=True)
    with open(RENDERER, "w", encoding="utf-8") as f:
        f.write("// Copyright (c) 2026 YCHsu. All rights reserved.\n")
        f.write("// Licensed under the MIT License.\n")
        f.write("// WebviewRenderer — extracted from OllamaChatPanel.getHtmlForWebview\n")
        f.write("// Sonnet refactor: Priority-1 split (pure HTML/CSS/JS, no side-effects)\n")
        f.write("import * as vscode from 'vscode';\n")
        f.write("\n")
        f.write("function getNonce(): string { return Math.random().toString(36).substring(2, 15); }\n")
        f.write("\n")
        f.write("export function getHtmlForWebview(_webview: vscode.Webview): string {\n")
        f.writelines(inner_body)
        f.write("}\n")

    renderer_lines = len(inner_body) + 11  # header + func sig + closing
    print(f"  WebviewRenderer.ts: ~{renderer_lines} lines written")

    # ── 2. Rebuild ollama-chat.ts ─────────────────────────────────────────────
    new_lines = []

    for i, line in enumerate(lines):
        if i == 0:
            # First line (copyright) — stays
            new_lines.append(line)
        elif i == 1:
            # Second line (licensed) — stays
            new_lines.append(line)
        elif re.match(r"^import \* as vscode from 'vscode';", line):
            # Add WebviewRenderer import after vscode import
            new_lines.append(line)
            new_lines.append("import { getHtmlForWebview } from './webview/WebviewRenderer';\n")
        elif i == start_idx:
            # Replace method with 3-line delegation
            new_lines.append(line)  # keep "  private getHtmlForWebview..." signature
            new_lines.append("    return getHtmlForWebview(_webview);\n")
            new_lines.append("  }\n")
        elif i > start_idx and i <= end_idx:
            # Skip the original body (replaced by delegation above)
            pass
        else:
            new_lines.append(line)

    with open(SRC, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    print(f"  ollama-chat.ts: {len(new_lines)} lines written")

    # ── 3. Verify ─────────────────────────────────────────────────────────────
    with open(SRC, encoding="utf-8") as f:
        content = f.read()

    checks = [
        ("import { getHtmlForWebview }", "WebviewRenderer import present"),
        ("return getHtmlForWebview(_webview)", "delegation call present"),
        ("private async handleTeamSend", "handleTeamSend preserved"),
        ("private async executeTool", "executeTool preserved"),
    ]
    all_ok = True
    for pattern, desc in checks:
        ok = pattern in content
        print(f"  {'✓' if ok else '✗'} {desc}")
        if not ok:
            all_ok = False

    if all_ok:
        print("\n  ✅ Split completed successfully.")
    else:
        print("\n  ❌ Some checks failed — review the output files.")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
