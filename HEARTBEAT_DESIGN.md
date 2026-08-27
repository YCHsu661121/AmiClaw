# Heartbeat Feature Design Document

## 1. Overview
The Heartbeat feature provides a periodic signaling mechanism to indicate the system's operational status. Other modules can register themselves as "watchers" or simply observe the heartbeat signal. A WebUI component will visualize this activity via a "Heartbeat LED/Indicator."

## 2. Requirements
- **Interval:** Approximately every 5 seconds.
- **Extensibility:** Ability for other modules to attach to or listen to the heartbeat event.
- **Observability:** A WebUI interface must display a visual indicator (e.g., a blinking light) that pulses with every heartbeat.
- **Reliability:** The heartbeat should be lightweight and not impact the performance of critical system modules.

## 3. Technical Architecture

### 3.1 Core Engine (Backend)
- **Heartbeat Manager (Singleton/Service):**
    - Maintains a timer/loop running every 5 seconds.
    - Responsible for triggering the "heartbeat event."
    - Manages a list of registered callback functions or event listeners.
- **Event Mechanism:**
    - Use an Observer pattern or an Event Emitter approach.
    - When the timer fires, all subscribed modules are notified.

### 3.2 Module Integration (Producer/Consumer)
- **Registration API:** A simple method like `HeartbeatManager.subscribe(callback)` for other modules to hook into.
- **Data Payload (Optional):** The heartbeat event can optionally carry system metadata (e.g., current timestamp, system load).

### 3.3 WebUI Integration (Frontend)
- **Communication Channel:**
    - **WebSocket (Recommended):** A WebSocket server pushes the "heartbeat" signal to the browser in real-time. This is low latency and efficient for periodic updates.
    - *Alternative:* Long Polling or SSE (Server-Sent Events) if WebSockets are not available.
- **UI Component:**
    - A small circular element (CSS-based) that changes color or flashes (e.g., `green` $\to$ `grey` $\to$ `green`) every 5 seconds.
    - Logic: Listen for the WebSocket message $\to$ Trigger CSS animation class.

## 4. Implementation Plan

### Phase 1: Backend Core
1. Implement `HeartbeatManager` in the backend (e.g., Python or Node.js depending on project structure).
2. Implement a periodic timer using `asyncio` or `setInterval`.
3. Implement the subscription mechanism for other modules.

### Phase 2: Web Communication
1. Set up a WebSocket endpoint (or SSE) within the existing web server.
2. Ensure the `HeartbeatManager` triggers a message to this endpoint on every pulse.

### Phase 3: Frontend Development
1. Create a simple UI component for the "Heartbeat LED".
2. Implement the WebSocket client logic to receive pulses and trigger CSS animations.

### Phase 4: Testing & Verification
1. Verify the interval is consistently ~5 seconds.
2. Verify that multiple modules can successfully subscribe without interference.
3. Verify visual sync between backend log/event and WebUI indicator.

## 5. Potential Challenges
- **Drift:** Ensuring the timer doesn't drift significantly over long periods.
- **Network Latency:** Visual delay between the actual heartbeat pulse and the WebUI update due to network lag (should be negligible for 5s interval).
- **Resource Usage:** Keeping the heartbeat mechanism lightweight to avoid overhead in high-frequency environments.
