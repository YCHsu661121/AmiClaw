# Heartbeat Feature Design Specification

## 1. Overview
A heartbeat mechanism to ensure the synchronization between the VS Code Extension (Backend) and the Webview (Frontend). It serves two purposes:
* **Module Synchronization**: Allows other extension modules to react to a periodic "tick" event.
* **Connection Monitoring**: Provides a visual "heartly light" in the WebUI to indicate that the extension process is alive.

## 2. Architecture

### A. Backend: `HeartbeatService` (Singleton)
- **Interval**: Every 5 seconds.
- **Observer Pattern**:
    - `onTick(callback: () => void): Disposable`: Allows modules to subscribe to the heartbeat event.
    - `start()` / `stop()`: Controls the execution of the `setInterval`.
- **Broadcaster**:
    - `broadcastToWebview(panel: OllamaChatPanel)`: Sends a `postMessage` containing `{ type: 'heartbeat', timestamp: Date.now() }` to the active Webview.

### B. Frontend: WebUI Heartbeat Light
- **UI Element**: A small circular `<span>` (the "light") placed in the `#topBarPrimary`.
- **Visual States**:
    - **Green (`#4ec994`)**: Received a message within the last 10 seconds.
     overlap with heartbeat interval.
    - **Red/Dim (`rgba(255,0,0,0.5)`)**: No message received for $>10$ seconds (indicates extension stall).
- **Logic**: A `setInterval` in the Webview script monitors the delta between `Date.now()` and the last received heartbeat timestamp.

## 3. Implementation Plan
1. Create `src/services/HeartbeatService.ts`.
2. Update `src/ollama-chat.ts` to subscribe and broadcast.
3. Update `src/webview/WebviewRenderer.ts` with CSS, HTML, and JS logic.
