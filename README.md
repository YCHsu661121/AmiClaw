# Ollama Chat — VS Code Extension

在 VS Code 側邊開啟 AI 聊天面板，直接連結本機 Ollama，支援對話、寫 code、一鍵插入、串流回應。  
所有資料都留在本機，不需要 OpenAI / GitHub Copilot 訂閱。

---

## 目錄

1. [前置需求](#前置需求)
2. [快速上手（三步完成）](#快速上手三步完成)
3. [Build 詳細說明](#build-詳細說明)
4. [安裝 Extension](#安裝-extension)
5. [開啟聊天視窗](#開啟聊天視窗)
6. [聊天介面功能說明](#聊天介面功能說明)
7. [設定（Settings）](#設定settings)
8. [Ollama Docker 管理](#ollama-docker-管理)
9. [疑難排解](#疑難排解)
10. [專案結構](#專案結構)

---

## 前置需求

| 項目 | 版本 | 說明 |
|------|------|------|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | ≥ 4.x | 用來 build `.vsix` 與執行 Ollama 伺服器 |
| [Visual Studio Code](https://code.visualstudio.com/) | ≥ 1.80 | 安裝 extension 的編輯器 |
| Node.js（可選） | ≥ 18 | 若想在本機直接 build，不使用 Docker |

> Docker Desktop 必須在背景執行。執行 `docker --version` 確認可用。

---

## 快速上手（三步完成）

```bat
:: ① 啟動 Ollama 伺服器（首次需要，之後開機自動重啟）
build.bat ollama start

:: ② 拉取模型（只需執行一次，約 4–8 GB）
build.bat ollama pull llama3

:: ③ 建置 extension 並安裝
build.bat
code --install-extension dist\ollama-chat.vsix
```

安裝後，在 VS Code 按 `Ctrl+Shift+P` 搜尋 **`Ollama Chat`** 並按 Enter，聊天視窗就會出現在右側。

---

## Build 詳細說明

### `build.bat` 子命令

```
build.bat [子命令]
```

| 子命令 | 說明 |
|--------|------|
| _(無參數)_ | 自動偵測：優先用本機 `npm`，若沒有則用 Docker build |
| `docker` | 強制使用 Docker 建置（推薦，環境乾淨可重現） |
| `local` | 強制使用本機 `npm`（需先裝 Node.js） |
| `clean` | 刪除 `node_modules/`、`out/`、`dist/` |
| `ollama start` | 用 Docker Compose 啟動 Ollama 伺服器 |
| `ollama stop` | 停止 Ollama 伺服器 |
| `ollama pull <model>` | 從 Ollama 拉取指定模型 |

### Docker Build 流程（`build.bat docker`）

```
Dockerfile（多階段）
  ┌─ builder stage（node:20-slim）
  │   1. COPY package.json → npm install       (Dependency layer，有快取)
  │   2. COPY src/ tsconfig.json → npm run compile  (tsc → out/)
  │   3. mkdir dist && npm run package         (vsce → dist/ollama-chat.vsix)
  └─ export stage（scratch）
      COPY /workspace/dist/ → /
      ↓ 用 --output type=local,dest=./dist 轉出到主機
```

執行結果：**`D:\Tools\Ollama\dist\ollama-chat.vsix`**（約 3–4 MB）

### 本機 Build 流程（`build.bat local`）

```
1. npm install    (安裝 devDependencies)
2. npm run compile      (tsc -p . → out/)
3. npm run package      (vsce package → dist/ollama-chat.vsix)
```

### docker-compose 架構

`docker-compose.yml` 定義兩個服務：

```yaml
services:
  ollama:   # ollama/ollama:latest，port 11434，模型 volume 持久保存
  builder:  # node:20-slim，執行 compile + package（profile: build）
```

- Ollama 使用 named volume `ollama-data`，重啟不會遺失下載的模型。
- 若有 NVIDIA GPU，在 `docker-compose.yml` 取消 `deploy.resources.reservations` 的註解即可啟用 GPU 加速。

---

## 安裝 Extension

### 方法一：指令列

```bat
code --install-extension dist\ollama-chat.vsix
```

### 方法二：VS Code GUI

1. 開啟 VS Code
2. 左側按 **Extensions** 圖示（或 `Ctrl+Shift+X`）
3. 右上角點 `…` → **Install from VSIX…**
4. 選擇 `D:\Tools\Ollama\dist\ollama-chat.vsix`
5. 出現提示時點 **Reload Window**

安裝成功後，左下角狀態列或 Extensions 清單會顯示 **Ollama Chat (v0.0.1)**。

---

## 開啟聊天視窗

安裝完成後，**有三種方式**可以開啟聊天面板：

### 方式 1：Command Palette（最常用）

1. 按 `Ctrl+Shift+P` 開啟命令面板
2. 輸入 `ollama`
3. 選擇 **`Ollama Chat`**

> 若找不到命令，請確認 extension 已啟用（Extensions 頁面搜尋 "ollama"）。

### 方式 2：鍵盤快捷鍵（自訂）

1. 按 `Ctrl+Shift+P` → 搜尋 **`Open Keyboard Shortcuts`**
2. 搜尋 `ollama.chat`
3. 雙擊並設定自己的快捷鍵（例如 `Ctrl+Alt+O`）

### 方式 3：extension 重新載入後自動出現

若面板已開啟過，重新載入視窗（`Ctrl+Shift+P` → **Reload Window**）後面板會保持在側邊。

---

## 聊天介面功能說明

```
┌─────────────────────────────────────────────┐
│  chat 視窗                                   │
│  ┌─ 對話區域（可捲動）─────────────────────┐ │
│  │  You: 請寫一個快速排序                   │ │
│  │  Assistant: 以下是 TypeScript 範例…      │ │
│  │  [插入程式碼] [摘要]                     │ │
│  └─────────────────────────────────────────┘ │
│  狀態：閒置                                  │
│  ┌──────────┐  ┌─────────────────────────┐  │
│  │model選單 │  │ 輸入框（可換行）         │  │
│  └──────────┘  └─────────────────────────┘  │
│  [送出] [一直做直到完成] [停止]              │
│  [切換串流模式] [清除]                       │
└─────────────────────────────────────────────┘
```

| 按鈕 | 功能 |
|------|------|
| **model 選單** | 切換要使用的 Ollama 模型（從設定讀取清單） |
| **送出** | 送出 prompt，等待完整回應 |
| **切換串流模式** | 啟用後回應逐字出現（類似 ChatGPT） |
| **一直做直到完成** | 自動連續呼叫 AI，直到回應 `DONE` 或達 50 輪 |
| **停止** | 中止自動執行 |
| **清除** | 清空聊天紀錄 |
| **插入程式碼** | 出現在 AI 回應的程式碼區塊下方，點選後把程式碼插入到目前游標位置 |
| **摘要** | 請 AI 將此回應濃縮成 3 條要點 |

---

## 設定（Settings）

在 VS Code `settings.json` 或 **Settings UI** 搜尋 `ollamaChat`：

| 設定鍵 | 預設值 | 說明 |
|--------|--------|------|
| `ollamaChat.url` | `http://localhost:11434` | Ollama 伺服器位址 |
| `ollamaChat.model` | `llama3` | 預設使用的模型 |
| `ollamaChat.models` | `["llama3","llama2","vicuna","mistral"]` | 下拉選單顯示的模型清單 |

### settings.json 範例

```jsonc
{
  "ollamaChat.url": "http://localhost:11434",
  "ollamaChat.model": "llama3",
  "ollamaChat.models": ["llama3", "mistral", "codellama", "phi3"]
}
```

---

## Ollama Docker 管理

Ollama 伺服器透過 `docker-compose.yml` 管理，資料存在 Docker volume，重啟不遺失。

```bat
:: 啟動伺服器
build.bat ollama start

:: 確認伺服器回應（瀏覽器或 curl）
curl http://localhost:11434

:: 列出已下載的模型
docker compose exec ollama ollama list

:: 拉取模型
build.bat ollama pull llama3
build.bat ollama pull mistral
build.bat ollama pull codellama

:: 停止伺服器
build.bat ollama stop
```

### 常用模型推薦

| 模型 | 大小 | 適合用途 |
|------|------|----------|
| `llama3` | ~4.7 GB | 通用對話、程式輔助（推薦） |
| `codellama` | ~3.8 GB | 專門寫 code |
| `mistral` | ~4.1 GB | 快速回應、程式輔助 |
| `phi3` | ~2.3 GB | 低記憶體機器適用 |

---

## 疑難排解

### 「找不到 Ollama Chat 命令」

- 確認 extension 已安裝：`Ctrl+Shift+X` → 搜尋 `ollama`
- 若顯示 disabled，點 **Enable**
- 重新載入視窗：`Ctrl+Shift+P` → **Reload Window**

### 「無法連線到 Ollama」

```bat
:: 確認 Ollama 伺服器正在執行
docker ps | findstr ollama

:: 若沒有，重新啟動
build.bat ollama start

:: 確認 port 11434 可連
curl http://localhost:11434
```

### Build 失敗

```bat
:: 清除快取後重新 build
build.bat clean
build.bat docker
```

### 模型回應緩慢

- 確認沒有其他大型應用程式佔用記憶體
- 嘗試更小的模型（如 `phi3`）
- 若有 NVIDIA GPU，在 `docker-compose.yml` 中啟用 GPU 支援（取消 `deploy` 區段的註解）

---

## 專案結構

```
D:\Tools\Ollama\
  src/
    extension.ts        # activate() 註冊 ollama.chat 命令
    ollama-chat.ts      # Webview 介面 + Ollama HTTP client
  Dockerfile            # 多階段 build（node:20-slim → scratch export）
  docker-compose.yml    # ollama 伺服器 + builder 服務
  build.bat             # Windows build 腳本與 Ollama 管理
  package.json          # VS Code Extension Manifest
  tsconfig.json         # TypeScript 設定
  Context.md            # 助理人格與專案筆記
  dist/
    ollama-chat.vsix    # ← build 後產生，用這個安裝
```
