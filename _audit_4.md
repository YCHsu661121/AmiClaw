# _audit_4 — Provider notes (src/providers)

Files under `src/providers/`: `ProviderRegistry.ts` (the only file).

(a) Provider "interface": no Provider class exists. `ProviderRegistry.ts` defines
`ProviderKind = 'ollama' | 'openai' | 'copilot'` and `interface ProviderInfo { id: ProviderKind; label: string }`,
mapping model-ID prefixes (`copilot::`, `openai::`, bare = ollama) to a kind via `getProviderKind()`.
The real tool Provider contract is `IToolProvider` (`src/tools/providers/IToolProvider.ts`):
`tools: ReadonlySet<string>` + `execute(name, args, ctx) => Promise<string>`.

(b) Registered provider names (all in `src/providers/ProviderRegistry.ts`):
- `copilot` → "Copilot" (model IDs `copilot::<id>`, legacy `copilot/<id>` auto-normalized)
- `openai` → "OpenAI Compatible" (model IDs `openai::<id>`)
- `ollama` → "Ollama" (model IDs without prefix)
No per-provider files; names live in the `KIND_LABEL` record.

(c) Tool registration: separate from src/providers/. `ToolExecutor.ts` (src/tools/ToolExecutor.ts)
instantiates each `IToolProvider` (Git/Jenkins/Search/Process/Vscode/FileSystem/Atlassian/Network/
Integration/DevTools/Lsp/Background/ComputerUse) in its constructor, then populates
`_providerMap` (tool name → provider) from each provider's `tools` set for O(1) dispatch.
