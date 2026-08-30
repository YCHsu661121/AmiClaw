# Chat message rendering — audit note

Chat messages are rendered **inline HTML** inside a VS Code webview; no external rendering library is used.
- `src/webview/WebviewRenderer.ts` — single file generating the entire webview HTML/CSS/JS via `getHtmlForWebview()` (extracted from `OllamaChatPanel.getHtmlForWebview`).
- Messages are appended to `#chat` as `.msg`/`.bubble` divs; DOM is built with `innerHTML` string templates + `createElement`.
- Markdown is handled by a **custom lightweight renderer**, not a library:
  - `parseBlocks()` splits text vs. ``` code fences; `renderTextBlock()` handles headings, lists, task items, tables, `$$` math blocks; `renderInline()` does inline formatting.
  - `highlightCode()` is an embedded tokenizer (JS/TS/Python/Shell/CSS/JSON) with `hl-*` CSS classes; other languages are escaped plaintext.
  - `rerenderBubbleMd()` re-renders a bubble's `.response-body` from raw text (used after streaming completes).
- Sessions are snapshotted/restored by saving `chat.innerHTML` per session (`s.html`), so rendering is purely HTML-string based.
- `src/panels/ChatPanelAdapter.ts` — only an adapter (`WebviewViewAdapter`) wrapping `WebviewView`/`WebviewPanel` as `PanelLike`; contains no rendering logic.
- Files involved: `src/webview/WebviewRenderer.ts`, `src/webview/WebviewRenderer.test.js`, `src/panels/ChatPanelAdapter.ts`.
