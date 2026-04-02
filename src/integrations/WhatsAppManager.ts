// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// WhatsAppManager – extracted from OllamaChatPanel.
// Owns all WhatsApp/Baileys state and message-handling logic.

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ── Callbacks contract ────────────────────────────────────────────────────────

export interface WhatsAppManagerCallbacks {
  /** Called when an incoming WA message should trigger the Agent. */
  onAgentTrigger: (prompt: string, model: string) => Promise<void>;
  /** Forward a message object to the VS Code webview. */
  postToWebview: (msg: object) => void;
  /** Request user permission for a sensitive tool operation. */
  requestPermission: (category: string, description: string, toolName?: string) => Promise<boolean>;
  /** Returns true while the Agent loop is currently running. */
  isAgentRunning: () => boolean;
  /** Returns true after the panel has been disposed. */
  isDisposed: () => boolean;
  /** Debug-log sink (mirrors OllamaChatPanel.log). */
  log: (msg: string) => void;
}

// ── WhatsAppManager ───────────────────────────────────────────────────────────

export class WhatsAppManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _waSock: any = null;
  private _waConnected = false;
  private _waConnecting = false;
  private _waPendingQr: ((result: string) => void) | null = null;
  /** WhatsApp 觸發 Agent 時為 true，requestPermission 自動允許（read/write/run），無需 UI 點擊 */
  private _waAgentMode = false;
  /** /model 指令切換的 WA Agent model（記憶體內，優先於設定檔） */
  private _waModelOverride = '';
  /** 上次發送「正在忙碌」回覆的時間（ms），60s 內只回一次 */
  private _waBusyRepliedAt = 0;
  /** extension 主動發出的訊息文字集合：收到 fromMe echo 時略過，避免自觸 Agent */
  private _waSentTexts = new Set<string>();
  /** WhatsApp 連線建立的時間（ms），用於過濾連線前的歷史同步訊息 */
  private _waConnectedAt = 0;
  /** 連續收到 440 connectionReplaced 的次數；超過 1 次即放棄重連 */
  private _wa440RetryCount = 0;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _cb: WhatsAppManagerCallbacks
  ) {}

  // ── Accessors ───────────────────────────────────────────────────────────────

  get agentMode(): boolean { return this._waAgentMode; }
  setAgentMode(value: boolean): void { this._waAgentMode = value; }
  get connected(): boolean { return this._waConnected; }
  get connecting(): boolean { return this._waConnecting; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get sock(): any { return this._waSock; }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** 中斷 WhatsApp Web (Baileys) 連線，清除狀態並通知 webview。*/
  async disconnect(): Promise<void> {
    const sock = this._waSock;
    this._waSock = null;
    this._waConnected = false;
    this._waConnecting = false;
    if (this._waPendingQr) {
      this._waPendingQr('連線已取消');
      this._waPendingQr = null;
    }
    if (sock) {
      try { await sock.logout(); } catch { /* ignore */ }
      try { sock.end(undefined); } catch { /* ignore */ }
    }
    this._cb.postToWebview({ type: 'waDisconnected' });
  }

  /**
   * 若 globalStorage 裡有 wa-auth/creds.json，嘗試靜默重連 WhatsApp（不顯示 QR 面板）。
   * 適用於 extension 重新啟動後自動恢復連線。
   * 若憑證已失效（QR 需重新掃描），會靜默放棄，等使用者手動呼叫 whatsapp_connect。
   */
  async tryAutoReconnect(): Promise<void> {
    const waAuthDir = path.join(this._context.globalStorageUri.fsPath, 'wa-auth');
    const credsFile = path.join(waAuthDir, 'creds.json');
    if (!fs.existsSync(credsFile)) { this._cb.log('WA auto-reconnect: no saved creds, skipping'); return; }
    if (this._waConnected || this._waConnecting) { this._cb.log('WA auto-reconnect: already connected/connecting, skipping'); return; }
    this._cb.log('WA auto-reconnect: found saved creds, attempting silent reconnect...');
    this._waConnecting = true;

    let baileysPkgJsonPath: string;
    try {
      baileysPkgJsonPath = require.resolve('@whiskeysockets/baileys/package.json');
    } catch {
      this._cb.log('WA auto-reconnect: Baileys not found, skipping');
      this._waConnecting = false;
      return;
    }

    try {
      const baileysPkg = JSON.parse(fs.readFileSync(baileysPkgJsonPath, 'utf-8')) as {
        exports?: Record<string, Record<string, string> | string>;
        main?: string;
      };
      const baileysPkgDir = path.dirname(baileysPkgJsonPath);
      const exportsEntry = baileysPkg.exports?.['.'];
      const esmRelPath = (typeof exportsEntry === 'object'
        ? exportsEntry['import'] ?? exportsEntry['default']
        : exportsEntry) ?? baileysPkg.main ?? 'lib/index.js';
      const baileyAbsPath = path.resolve(baileysPkgDir, esmRelPath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const baileyUrl = (require('url') as typeof import('url')).pathToFileURL(baileyAbsPath).href;
      // eslint-disable-next-line no-new-func
      const esmImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
      esmImport(baileyUrl).then(async Baileys => {
        try {
          const makeWASocket = (Baileys as Record<string, unknown>)['makeWASocket'] as (opts: Record<string, unknown>) => Record<string, unknown>;
          const useMultiFileAuthState = (Baileys as Record<string, unknown>)['useMultiFileAuthState'] as (dir: string) => Promise<{ state: unknown; saveCreds: () => void }>;
          const DisconnectReason = (Baileys as Record<string, unknown>)['DisconnectReason'] as Record<string, number>;
          const fetchLatestBaileysVersion = (Baileys as Record<string, unknown>)['fetchLatestBaileysVersion'] as () => Promise<{ version: [number, number, number]; isLatest: boolean }>;
          const BrowsersHelper = (Baileys as Record<string, unknown>)['Browsers'] as Record<string, (s: string) => [string, string, string]> | undefined;
          const DEFAULT_CFG = (Baileys as Record<string, unknown>)['DEFAULT_CONNECTION_CONFIG'] as { version?: [number, number, number] } | undefined;

          const { state, saveCreds } = await useMultiFileAuthState(waAuthDir);
          const defaultVersion: [number, number, number] = DEFAULT_CFG?.version ?? [2, 3000, 1023223821];
          let waVersion: [number, number, number] = defaultVersion;
          try {
            const r = await fetchLatestBaileysVersion();
            waVersion = r.version;
          } catch { /* use Baileys default */ }

          const noopLogger = { info: ()=>{}, debug: ()=>{}, trace: ()=>{}, warn: ()=>{}, error: ()=>{}, fatal: ()=>{}, silent: ()=>{}, level: 'silent', child: () => noopLogger };
          const browserInfo = BrowsersHelper?.appropriate?.('Chrome') ?? BrowsersHelper?.ubuntu?.('Chrome') ?? ['Ubuntu', 'Chrome', '22.0.0'];

          const startSock = async () => {
            const sock = makeWASocket({
              auth: state as Record<string, unknown>,
              version: waVersion,
              browser: browserInfo,
              printQRInTerminal: false,
              logger: noopLogger,
              connectTimeoutMs: 60_000,
            });
            this._waSock = sock;
            const sockEv = (sock as Record<string, unknown>)['ev'] as { on(event: string, handler: (...a: unknown[]) => void): void };

            sockEv.on('connection.update', async (...evArgs: unknown[]) => {
              const update = evArgs[0] as Record<string, unknown>;
              const { connection, lastDisconnect, qr } = update as { connection?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } }; qr?: string };
              this._cb.log('WA auto-reconnect update: connection=' + connection + ' qr=' + (qr ? 'yes' : 'no'));
              if (qr) {
                // 有 QR 表示憑證已失效，靜默放棄（使用者需手動呼叫 whatsapp_connect）
                this._cb.log('WA auto-reconnect: QR needed, credentials expired, aborting silent reconnect');
                this._waSock = null;
                this._waConnecting = false;
                try { (sock as Record<string, (...a: unknown[]) => unknown>)?.end?.(undefined); } catch { /* ignore */ }
                return;
              }
              if (connection === 'open') {
                this._waConnected = true;
                this._waConnectedAt = Date.now();
                this._wa440RetryCount = 0;  // 連線成功，重置計數器
                this._waConnecting = false;
                try {
                  const creds = (sock as Record<string, unknown>)['authState'] as Record<string, unknown> | undefined;
                  const meObj = ((creds?.['creds'] as Record<string, unknown> | undefined)?.['me']) as Record<string, unknown> | undefined;
                  const meId: string = String(meObj?.['id'] ?? '') || '';
                  const myPhone = meId.replace(/:.*/, '').replace(/@.*/, '');
                  if (myPhone) {
                    await this._context.globalState.update('amiAiClaw.waPhone', myPhone);
                    this._cb.log('WA auto-reconnect: connected! phone=+' + myPhone);
                  }
                  const savedPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
                  this._cb.postToWebview({ type: 'waConnected', phone: savedPhone ? '+' + savedPhone : '' });
                } catch {
                  this._cb.postToWebview({ type: 'waConnected', phone: '' });
                }
              }
              if (connection === 'close') {
                const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
                this._cb.log('WA auto-reconnect close: code=' + statusCode);
                if (statusCode === 515) {
                  this._waSock = null;
                  this._waConnected = false;
                  setTimeout(() => { startSock().catch(e2 => this._cb.log('WA auto-reconnect restart err: ' + String(e2))); }, 500);
                  return;
                }
                // 440 = connectionReplaced — 同一帳號在另一處開啟了 WA Web，等 30s 後重連
                if (statusCode === 440) {
                  this._wa440RetryCount++;
                  this._cb.log(`WA auto-reconnect: connectionReplaced (440), retryCount=${this._wa440RetryCount}`);
                  this._waSock = null;
                  this._waConnected = false;
                  this._waConnecting = false;
                  this._cb.postToWebview({ type: 'waDisconnected' });
                  if (this._wa440RetryCount <= 1) {
                    // 第一次被踢：等 30s 後試一次（對方 tab 可能已關閉）
                    this._cb.log('WA auto-reconnect: will retry once in 30s...');
                    setTimeout(() => {
                      if (!this._waConnected && !this._waConnecting) {
                        this._waConnecting = true;
                        startSock().catch(e2 => { this._waConnecting = false; this._cb.log('WA auto-reconnect 440-retry err: ' + String(e2)); });
                      }
                    }, 30_000);
                  } else {
                    // 重試也被踢：對方 session 仍存活，放棄不出跨註釋放
                    this._cb.log('WA auto-reconnect: another session still active, giving up to avoid loop (440x' + this._wa440RetryCount + ')');
                  }
                  return;
                }
                this._waSock = null;
                this._waConnected = false;
                this._waConnecting = false;
                if (statusCode === DisconnectReason.loggedOut) {
                  try { fs.rmSync(waAuthDir, { recursive: true, force: true }); } catch { /* ignore */ }
                }
                this._cb.postToWebview({ type: 'waDisconnected' });
              }
            });

            sockEv.on('creds.update', saveCreds as (...a: unknown[]) => void);

            sockEv.on('messages.upsert', async (...evArgs: unknown[]) => {
              const upsert = evArgs[0] as { messages: Record<string, unknown>[]; type: string };
              this._cb.log(`WA upsert [auto-reconnect] type=${upsert.type} count=${upsert.messages?.length}`);
              for (const msg of upsert.messages) {
                const k = msg['key'] as Record<string,unknown> | undefined;
                const fromMe = !!(k?.['fromMe']);
                const remoteJid = String(k?.['remoteJid'] ?? '');
                this._cb.log(`WA msg: fromMe=${fromMe} jid=${remoteJid} type=${upsert.type}`);
                if (upsert.type !== 'notify' && !fromMe) { continue; }
                this.handleIncoming(msg).catch(e => this._cb.log('WA handleIncoming error: ' + String(e)));
              }
            });
          };

          await startSock();
          // 60 秒靜默重連逾時（若憑證有效應在 20s 內完成）
          setTimeout(() => {
            if (this._waConnecting) {
              this._cb.log('WA auto-reconnect: timed out (60s)');
              try { (this._waSock as Record<string, (...a: unknown[]) => unknown>)?.end?.(undefined); } catch { /* ignore */ }
              this._waSock = null;
              this._waConnecting = false;
            }
          }, 60_000);
        } catch (e) {
          this._waConnecting = false;
          this._cb.log('WA auto-reconnect inner error: ' + String(e));
        }
      }).catch(e => {
        this._waConnecting = false;
        this._cb.log('WA auto-reconnect Baileys load error: ' + String(e));
      });
    } catch (e) {
      this._waConnecting = false;
      this._cb.log('WA auto-reconnect outer error: ' + String(e));
    }
  }

  /**
   * 處理 WhatsApp 收到的訊息：顯示在聊天視窗，並自動送入 Agent 執行。
   * 由 messages.upsert 事件觸發（兩個 socket：whatsapp_connect 和 tryAutoReconnect 共用）。
   */
  async handleIncoming(msg: Record<string, unknown>): Promise<void> {
    if (this._cb.isDisposed()) { return; } // panel 已關閉，跳過（WA socket 仍在運行）
    const msgKey = msg['key'] as Record<string, unknown>;
    const fromMe = !!(msg['key'] && msgKey['fromMe']);
    const remoteJid = String(msgKey['remoteJid'] ?? '');
    if (!remoteJid) { return; }
    this._cb.log(`WA _handleWaIncoming: fromMe=${fromMe} jid=${remoteJid}`);
    // fromMe=true 表示自己送出的訊息；但若 remoteJid 是自己的號碼（Note to self），仍允許觸發 Agent
    if (fromMe) {
      let myPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
      // remoteJid 可能含設備號 :N（如 886919327569:5@s.whatsapp.net），需一併去除
      const remotePhone = remoteJid.replace(/@.+/, '').replace(/:.*/, '');
      // 若 waPhone 尚未儲存（auto-reconnect 在 debug log 開啟前完成），嘗試從 socket 讀取
      if (!myPhone && this._waSock) {
        try {
          const creds = (this._waSock as Record<string, unknown>)['authState'] as Record<string, unknown> | undefined;
          const meObj = ((creds?.['creds'] as Record<string, unknown> | undefined)?.['me']) as Record<string, unknown> | undefined;
          const meId = String(meObj?.['id'] ?? '');
          myPhone = meId.replace(/:.*/, '').replace(/@.*/, '');
          if (myPhone) {
            void this._context.globalState.update('amiAiClaw.waPhone', myPhone);
            this._cb.log(`WA _handleWaIncoming: recovered waPhone=${myPhone}`);
          }
        } catch { /* ignore */ }
      }
      this._cb.log(`WA _handleWaIncoming: myPhone=${myPhone} remotePhone=${remotePhone}`);
      // @lid 是 WhatsApp LID 格式（隱私保護的混淆 ID），fromMe=true 時必然是自己的設備，直接放行
      const isLid = remoteJid.endsWith('@lid');
      if (!isLid && (!myPhone || remotePhone !== myPhone)) { return; } // 發給別人的訊息：忽略
      // Note to self：繼續往下處理
    }
    let msgContent = msg['message'] as Record<string, unknown> | undefined;
    if (!msgContent) {
      this._cb.log(`WA _handleWaIncoming: no msgContent, keys=${Object.keys(msg).join(',')}`);
      return;
    }
    // Note-to-self 訊息可能包在 deviceSentMessage 裡
    if (msgContent['deviceSentMessage']) {
      const dsm = msgContent['deviceSentMessage'] as Record<string, unknown> | undefined;
      const inner = dsm?.['message'] as Record<string, unknown> | undefined;
      if (inner) {
        this._cb.log('WA _handleWaIncoming: unwrapping deviceSentMessage');
        msgContent = inner;
      }
    }
    // 取出文字內容（支援各種訊息類型）
    const text: string =
      String(msgContent['conversation'] ?? '') ||
      String((msgContent['extendedTextMessage'] as Record<string, unknown> | undefined)?.['text'] ?? '') ||
      String((msgContent['imageMessage'] as Record<string, unknown> | undefined)?.['caption'] ?? '') ||
      String((msgContent['videoMessage'] as Record<string, unknown> | undefined)?.['caption'] ?? '') ||
      '';
    this._cb.log(`WA _handleWaIncoming: text="${text.slice(0,50)}" msgKeys=${Object.keys(msgContent).join(',')}`);
    if (!text.trim()) { return; } // 非文字訊息（語音、貼圖等）忽略

    // 過濾連線建立前的歷史同步訊息（type=append 歷史同步）：只處理連線後到達的訊息
    const msgTs = Number(msg['messageTimestamp'] ?? 0) * 1000; // Baileys 時間戳是秒數
    if (msgTs > 0 && this._waConnectedAt > 0 && msgTs < this._waConnectedAt - 3000) {
      this._cb.log(`WA _handleWaIncoming: skipping pre-connection message ts=${new Date(msgTs).toISOString()}`);
      return;
    }

    // 若是 extension 自己送出訊息的 echo（fromMe=true），略過不處理
    if (fromMe && this._waSentTexts.has(text)) {
      this._cb.log('WA _handleWaIncoming: skipping self-sent echo');
      return;
    }

    // ── /module 內建指令（優先於 Agent，白名單前處理）──────────────────────
    const trimmed = text.trim();
    if (/^\/(?:module|model|llm)\b/i.test(trimmed)) {
      await this.handleModuleCommand(trimmed, msg);
      return;
    }
    // ──────────────────────────────────────────────────────────────────────

    // @lid 是 WhatsApp 隱私混淆 ID，fromMe=true 時必然是自己，senderPhone 改用已知的 myPhone
    const isLidJid = remoteJid.endsWith('@lid');
    // 去除 remoteJid 中的設備號 :N（如 886919327569:5@s.whatsapp.net → 886919327569）
    const rawSenderPhone = remoteJid.replace(/@.+/, '').replace(/:.*/, '');
    const ownPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
    const senderPhone = (fromMe && isLidJid)
      ? (ownPhone || rawSenderPhone)
      : rawSenderPhone;
    // @lid JID 無法用於 sendMessage（靜默失敗）；改用自己的 @s.whatsapp.net JID
    const sendJid = isLidJid && ownPhone ? `${ownPhone}@s.whatsapp.net` : remoteJid;
    const pushName = String(msg['pushName'] ?? '');
    const displaySender = pushName ? `${pushName} (+${senderPhone})` : `+${senderPhone}`;
    this._cb.log(`WA incoming from ${displaySender}${fromMe ? ' [note-to-self]' : ''}: ${text} (sendJid=${sendJid})`);
    // 在聊天視窗顯示收到的訊息（panel 可能已關閉，try-catch 防止拋出）
    try { this._cb.postToWebview({ type: 'waIncoming', sender: displaySender, text, remoteJid }); } catch { /* disposed */ }
    // 白名單過濾：fromMe+@lid 必然是本人，直接放行；其他號碼需比對白名單
    const pcfg = vscode.workspace.getConfiguration('amiAiClaw');
    const allowedSenders = pcfg.get<string[]>('waAgentAllowedSenders', []);
    const skipWhitelist = fromMe && isLidJid;
    if (!skipWhitelist && allowedSenders.length > 0 && !allowedSenders.includes(senderPhone)) {
      this._cb.log(`WA incoming: ${senderPhone} 不在白名單，略過 Agent`);
      return;
    }
    // 自動送入 Agent 執行（若 agent 正在執行中則略過，避免衝突）
    if (this._cb.isAgentRunning()) {
      this._cb.log('WA incoming: agent busy, skipping auto-run');
      // fromMe（自己發給自己）不需要回「正在忙碌」，本人自知
      const now = Date.now();
      if (!fromMe && now - this._waBusyRepliedAt > 60_000) {
        this._waBusyRepliedAt = now;
        try {
          if (this._waSock && sendJid) {
            const busyText = '[AmiClaw] ⏳ 我目前正在處理另一個任務，請稍候再試。';
            this._waSentTexts.add(busyText);
            setTimeout(() => { this._waSentTexts.delete(busyText); }, 30_000);
            await (this._waSock as Record<string, (j: string, m: Record<string, unknown>) => Promise<void>>)
              .sendMessage(sendJid, { text: busyText });
          }
        } catch (e) { this._cb.log('WA busy-reply error: ' + String(e)); }
      }
      return;
    }
    // 優先使用 _waModelOverride（/model 指令記憶體內切換），其次 waAgentModel 設定，最後 fallback 到 UI 當前 model
    const waAgentModel = this._waModelOverride || pcfg.get<string>('waAgentModel', '') || pcfg.get<string>('model') || '';
    this._cb.log(`WA incoming: using model="${waAgentModel}"`);
    // 先回傳「正在思考」提示，讓對方知道已收到指令
    try {
      if (this._waSock && sendJid) {
        const thinkingText = '[AmiClaw] 🤔 收到指令，正在處理中…';
        this._waSentTexts.add(thinkingText);
        setTimeout(() => { this._waSentTexts.delete(thinkingText); }, 30_000);
        await (this._waSock as Record<string, (j: string, m: Record<string, unknown>) => Promise<void>>)
          .sendMessage(sendJid, { text: thinkingText });
      }
    } catch (e) { this._cb.log('WA thinking-reply error: ' + String(e)); }
    const agentPrompt = `[WhatsApp 指令，來自 ${displaySender}]\n${text}\n\n請處理此指令。處理完後，使用 whatsapp_send 將結果回覆給 +${senderPhone}。`;
    // waTriggered=true：工具執行時自動允許（不等待 UI 點擊）
    this._cb.onAgentTrigger(agentPrompt, waAgentModel).catch(e => this._cb.log('WA agent error: ' + String(e)));
  }

  /**
   * 處理 WhatsApp /module 內建指令（不走 Agent，直接同步回覆）。
   * 支援：
   *   /module list              → 列出所有可用 Ollama + Copilot 模型（帶編號）
   *   /module <N>               → 切換 waAgentModel 為第 N 個模型
   *   /module <name>            → 切換 waAgentModel 為名稱模糊相符的模型
   */
  async handleModuleCommand(text: string, msg: Record<string, unknown>): Promise<void> {
    this._cb.log(`WA /module command: "${text}"`);

    // 取得回覆 JID（原訊息的 remoteJid）
    // @lid JID 是 WhatsApp 隱私混淆 ID，sendMessage 到 @lid 靜默失敗；
    // 改用自己的 @s.whatsapp.net JID（Note-to-self 模式）
    const msgKey = msg['key'] as Record<string, unknown> | undefined;
    let replyJid = String(msgKey?.['remoteJid'] ?? '');
    if (replyJid.endsWith('@lid')) {
      const ownPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
      if (ownPhone) replyJid = `${ownPhone}@s.whatsapp.net`;
    }
    this._cb.log(`WA /module replyJid: ${replyJid}`);
    const send = async (body: string) => {
      const prefixed = body.startsWith('[AmiClaw]') ? body : `[AmiClaw] ${body}`;
      try {
        if (this._waSock && replyJid) {
          this._waSentTexts.add(prefixed);
          setTimeout(() => { this._waSentTexts.delete(prefixed); }, 30_000);
          await (this._waSock as Record<string, (j: string, m: Record<string, unknown>) => Promise<void>>)
            .sendMessage(replyJid, { text: prefixed });
          this._cb.log(`WA /module sent OK (${prefixed.length} chars) -> ${replyJid}`);
        }
      } catch (e) { this._cb.log(`WA /module reply error: ${String(e)}`); }
    };

    // 建立完整模型清單（Ollama + Copilot）— Ollama URLs 並行查詢
    const buildModuleList = async (): Promise<{ id: string; label: string }[]> => {
      const cfg = vscode.workspace.getConfiguration('amiAiClaw');
      const urls = WhatsAppManager._getOllamaUrls(cfg);
      this._cb.log(`WA /module buildModuleList: ${urls.length} Ollama URL(s)`);
      const list: { id: string; label: string }[] = [];
      // 並行查詢所有 Ollama URLs（避免串行等待每個 8s timeout）
      const results = await Promise.allSettled(urls.map(url => WhatsAppManager._ollamaListModels(url).then(models => ({ url, models }))));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const m of r.value.models) {
            list.push({ id: WhatsAppManager._encodeOllamaModelId(r.value.url, m, urls), label: WhatsAppManager._ollamaDisplayLabel(r.value.url, m, urls) });
          }
        }
      }
      try {
        const lms = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const seen = new Set<string>();
        for (const m of lms) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            const name = (m.name || m.family).replace(/\s+\d+x\b|\s+x\d+\b/gi, '').trim();
            list.push({ id: `copilot::${m.id}`, label: `[Copilot] ${name}` });
          }
        }
      } catch { /* Copilot not available */ }
      this._cb.log(`WA /module buildModuleList: ${list.length} models total`);
      return list;
    };

    const parts = text.trim().split(/\s+/);
    // 移除第一個 token（/module、/model、/llm 都視為同一指令）
    const sub = parts[1]?.toLowerCase() ?? '';

    // /module list
    if (!sub || sub === 'list') {
      const list = await buildModuleList();
      if (list.length === 0) {
        await send('⚠️ 目前沒有可用的模型（Ollama 未連線且 Copilot 不可用）');
        return;
      }
      const cfg2 = vscode.workspace.getConfiguration('amiAiClaw');
      const current = this._waModelOverride || cfg2.get<string>('waAgentModel', '') || cfg2.get<string>('model', '');
      const lines = list.map((m, i) => {
        const active = (m.id === current || m.label === current) ? ' ✅' : '';
        return `${i + 1}. ${m.label}${active}`;
      });
      await send(`📋 可用模型（/module <編號> 切換）：\n\n${lines.join('\n')}\n\n目前 WA Agent 使用：${current || '(同 UI 選擇)'}`);
      return;
    }

    // /module <N> 或 /module <name>
    const list2 = await buildModuleList();
    if (list2.length === 0) {
      await send('⚠️ 目前沒有可用的模型');
      return;
    }

    let target: { id: string; label: string } | undefined;
    const num = parseInt(sub, 10);
    if (!isNaN(num) && num >= 1 && num <= list2.length) {
      target = list2[num - 1];
    } else {
      // 模糊比對 label 或 id
      const q = parts.slice(1).join(' ').toLowerCase();
      target = list2.find(m => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
    }

    if (!target) {
      await send(`❌ 找不到模型「${parts.slice(1).join(' ')}」，請用 /module list 查看清單`);
      return;
    }

    // 寫入設定，同時更新記憶體內覆蓋値（讓下一條指令立即生效）
    try {
      this._waModelOverride = target.id;
      const cfg3 = vscode.workspace.getConfiguration('amiAiClaw');
      await cfg3.update('waAgentModel', target.id, vscode.ConfigurationTarget.Global);
      this._cb.log(`WA /module: switched waAgentModel to "${target.id}"`);
      await send(`✅ WA Agent 模型已切換為：\n${target.label}\n\n（ID: ${target.id}）`);
    } catch (e) {
      this._waModelOverride = '';
      await send(`❌ 切換失敗：${String(e)}`);
    }
  }

  /**
   * Handle all whatsapp_* tool calls dispatched from OllamaChatPanel.executeTool().
   * Returns the tool result string.
   */
  async handleTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {

      case 'whatsapp_connect': {
        if (this._waConnecting) return '⏳ WhatsApp Web 正在連線中，請等待 QR Code 顯示後掃描';
        // 若 auto-reconnect 已成功建立有效連線，直接回報狀態
        if (this._waConnected && this._waSock) {
          const savedPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
          return `✅ WhatsApp Web 已連線${savedPhone ? '，號碼：+' + savedPhone : ''}（session 仍有效，無需重新掃描 QR）`;
        }
        // 清理殭屍 socket（已斷線但未清除的情況）
        if (this._waSock) {
          const oldSock = this._waSock;
          this._waSock = null;
          this._waConnected = false;
          try { (oldSock as Record<string, (...a: unknown[]) => unknown>)?.end?.(undefined); } catch { /* ignore */ }
        }
        this._waConnecting = true;
        const waAuthDir = path.join(this._context.globalStorageUri.fsPath, 'wa-auth');
        // force=true 才清 session；預設保留 creds，讓 Baileys 決定是否需要 QR
        const waForce = (args.force as boolean) === true;
        if (waForce) {
          try { fs.rmSync(waAuthDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        fs.mkdirSync(waAuthDir, { recursive: true });
        const hasSavedSession = !waForce && fs.existsSync(path.join(waAuthDir, 'creds.json'));
        // 顯示 QR 面板（loading 狀態）
        const initMsg = hasSavedSession
          ? '⏳ 嘗試恢復已儲存的 WhatsApp session，請稍候…（若 session 仍有效則無需掃描 QR）'
          : '⏳ 初始化中，請稍候…';
        this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: initMsg });
        return new Promise<string>(resolve => {
          this._waPendingQr = resolve;
          // Baileys 是 ESM-only 套件，在 CJS 模組中需要使用原生 dynamic import 載入。
          // 步驟：
          //   1. require.resolve() 找到套件的 package.json（在 CJS 作用域，能正確解析 node_modules）
          //   2. 讀取 package.json 取得 ESM entry (exports['.'].import 或 main)
          //   3. 轉為 file:// URL 後用 new Function 包裝的 import() 載入
          //      （new Function 讓 TypeScript 不把 import() 轉為 require()）
          let baileysPkgJsonPath: string;
          try {
            baileysPkgJsonPath = require.resolve('@whiskeysockets/baileys/package.json');
          } catch (e) {
            const msg = '❌ 找不到 @whiskeysockets/baileys 套件。\n請在 D:\\Tools\\Ollama 目錄執行：\n  docker run --rm -v "%CD%:/workspace" -w /workspace node:20-slim sh -c "apt-get update -qq && apt-get install -y --no-install-recommends git > /dev/null 2>&1 && npm install"\n或重新打包安裝最新 .vsix';
            if (this._waPendingQr) { this._waPendingQr(msg); this._waPendingQr = null; }
            this._waConnecting = false;
            this._cb.postToWebview({ type: 'waDisconnected' });
            return;
          }
          try {
            const baileysPkg = JSON.parse(fs.readFileSync(baileysPkgJsonPath, 'utf-8')) as {
              exports?: Record<string, Record<string, string> | string>;
              main?: string;
            };
            const baileysPkgDir = path.dirname(baileysPkgJsonPath);
            const exportsEntry = baileysPkg.exports?.['.'];
            const esmRelPath = (typeof exportsEntry === 'object'
              ? exportsEntry['import'] ?? exportsEntry['default']
              : exportsEntry) ?? baileysPkg.main ?? 'lib/index.js';
            const baileyAbsPath = path.resolve(baileysPkgDir, esmRelPath);
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const baileyUrl = (require('url') as typeof import('url')).pathToFileURL(baileyAbsPath).href;
            this._cb.log('WA: loading Baileys from ' + baileyUrl);
            this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: '⏳ 載入 Baileys 模組 (ESM) 中…' });
            // eslint-disable-next-line no-new-func
            const esmImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>;
            esmImport(baileyUrl).then(async Baileys => {
            try {
              const makeWASocket = (Baileys as Record<string, unknown>)['makeWASocket'] as (opts: Record<string, unknown>) => Record<string, unknown>;
              const useMultiFileAuthState = (Baileys as Record<string, unknown>)['useMultiFileAuthState'] as (dir: string) => Promise<{ state: unknown; saveCreds: () => void }>;
              const DisconnectReason = (Baileys as Record<string, unknown>)['DisconnectReason'] as Record<string, number>;
              const fetchLatestBaileysVersion = (Baileys as Record<string, unknown>)['fetchLatestBaileysVersion'] as () => Promise<{ version: [number, number, number]; isLatest: boolean }>;
              const BrowsersHelper = (Baileys as Record<string, unknown>)['Browsers'] as Record<string, (s: string) => [string, string, string]> | undefined;
              const DEFAULT_CFG = (Baileys as Record<string, unknown>)['DEFAULT_CONNECTION_CONFIG'] as { version?: [number, number, number] } | undefined;
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const QRCode = require('qrcode') as { toDataURL: (text: string, opts?: Record<string, unknown>) => Promise<string> };
              this._cb.log('WA: Baileys loaded OK, initializing auth state');
              this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: '⏳ 初始化 WhatsApp 認證狀態…' });
              const { state, saveCreds } = await useMultiFileAuthState(waAuthDir);
              this._cb.log('WA: auth state loaded, fetching WA version');
              this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: '⏳ 取得最新 WhatsApp Web 版本…' });
              // 取得最新 WA Web 版本，避免 405 連線拒絕（舊版不相容）
              const defaultVersion: [number, number, number] = DEFAULT_CFG?.version ?? [2, 3000, 1023223821];
              let waVersion: [number, number, number] = defaultVersion;
              try {
                const r = await fetchLatestBaileysVersion();
                waVersion = r.version;
                this._cb.log('WA: fetched version ' + waVersion.join('.') + ' isLatest=' + r.isLatest);
              } catch (e) {
                this._cb.log('WA: fetchLatestBaileysVersion failed, using Baileys default ' + defaultVersion.join('.') + ': ' + String(e));
              }
              this._cb.log('WA: using version ' + waVersion.join('.'));
              const noopLogger = { info: ()=>{}, debug: ()=>{}, trace: ()=>{}, warn: ()=>{}, error: ()=>{}, fatal: ()=>{}, silent: ()=>{}, level: 'silent', child: () => noopLogger };
              const browserInfo = BrowsersHelper?.appropriate?.('Chrome') ?? BrowsersHelper?.ubuntu?.('Chrome') ?? ['Ubuntu', 'Chrome', '22.0.0'];

              // 抽成 startSock，以便 515 restartRequired 時重新建立 socket
              const startSock = async () => {
                this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: '⏳ 連接 WhatsApp 伺服器中，等待 QR 碼…' });
                const sock = makeWASocket({
                  auth: state as Record<string, unknown>,
                  version: waVersion,
                  browser: browserInfo,
                  printQRInTerminal: false,
                  logger: noopLogger,
                  connectTimeoutMs: 60_000,
                });
                this._waSock = sock;
                this._cb.log('WA: socket created, registering event handlers');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const sockEv = (sock as Record<string, unknown>)['ev'] as { on(event: string, handler: (...a: unknown[]) => void): void };
                sockEv.on('connection.update', async (...evArgs: unknown[]) => {
                  const update = evArgs[0] as Record<string, unknown>;
                  const { connection, lastDisconnect, qr } = update as { connection?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } }; qr?: string };
                  this._cb.log('WA connection.update: connection=' + connection + ' qr=' + (qr ? 'yes' : 'no'));
                  if (qr) {
                    try {
                      const imgDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
                      this._cb.postToWebview({ type: 'waQrCode', imgDataUrl });
                    } catch (e) {
                      const errMsg2 = '❌ QR Code 圖片產生失敗：' + String(e);
                      this._cb.log('WA QR generate error: ' + String(e));
                      if (this._waPendingQr) { this._waPendingQr(errMsg2); this._waPendingQr = null; }
                    }
                  }
                  if (connection === 'open') {
                    this._waConnected = true;
                    this._waConnectedAt = Date.now();
                    this._wa440RetryCount = 0;  // 連線成功，重置計數器
                    this._waConnecting = false;
                    // 取出自己的號碼並存到 globalState
                    try {
                      const creds = (sock as Record<string, unknown>)['authState'] as Record<string, unknown> | undefined;
                      const meObj = ((creds?.['creds'] as Record<string, unknown> | undefined)?.['me']) as Record<string, unknown> | undefined;
                      const meId: string = String(meObj?.['id'] ?? '') || '';
                      const myPhone = meId.replace(/:.*/, '').replace(/@.*/, ''); // 去掉 :N@s.whatsapp.net
                      if (myPhone) {
                        await this._context.globalState.update('amiAiClaw.waPhone', myPhone);
                        this._cb.log('WA: saved phone ' + myPhone);
                        this._cb.postToWebview({ type: 'waConnected', phone: '+' + myPhone });
                      } else {
                        this._cb.postToWebview({ type: 'waConnected', phone: '' });
                      }
                    } catch {
                      this._cb.postToWebview({ type: 'waConnected', phone: '' });
                    }
                    if (this._waPendingQr) {
                      const savedPhone = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
                      this._waPendingQr('✅ WhatsApp Web 連線成功！' + (savedPhone ? '號碼：+' + savedPhone + '  ' : '') + '現在可以使用 whatsapp_send 發送訊息（無需 Access Token）');
                      this._waPendingQr = null;
                    }
                  }
                  if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
                    const errMsg = (lastDisconnect?.error as { message?: string } | undefined)?.message ?? '';
                    this._cb.log('WA: connection close code=' + statusCode + ' msg=' + errMsg);
                    // 515 = restartRequired：重新建立 socket，不視為錯誤
                    if (statusCode === 515) {
                      this._cb.log('WA: restartRequired (515), restarting socket...');
                      this._waSock = null;
                      this._waConnected = false;
                      setTimeout(() => { startSock().catch(e2 => this._cb.log('WA restart error: ' + String(e2))); }, 500);
                      return;
                    }
                    // 440 = connectionReplaced — 同一帳號在別處開啟 WA Web，等 30s 自動重連
                    if (statusCode === 440) {
                      this._wa440RetryCount++;
                      this._cb.log(`WA: connectionReplaced (440), retryCount=${this._wa440RetryCount}`);
                      this._waSock = null;
                      this._waConnected = false;
                      this._waConnecting = false;
                      this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: `⚠️ WhatsApp 連線被其他裝置取代（440）${this._wa440RetryCount <= 1 ? '，30 秒後自動重連...' : '，對方 session 仍存活，停止重連。'}` });
                      setTimeout(() => {
                        this._cb.postToWebview({ type: 'waDisconnected' });
                        if (this._wa440RetryCount <= 1 && !this._waConnected && !this._waConnecting && this._waSock === null) {
                          this._cb.log('WA: retrying once after connectionReplaced...');
                          this._waConnecting = true;
                          startSock().catch(e2 => { this._waConnecting = false; this._cb.log('WA 440-retry error: ' + String(e2)); });
                        } else if (this._wa440RetryCount > 1) {
                          this._cb.log('WA: another session still active, giving up to avoid loop (440x' + this._wa440RetryCount + ')');
                        }
                      }, 30_000);
                      return;
                    }
                    this._waSock = null;
                    this._waConnected = false;
                    this._waConnecting = false;
                    if (statusCode === DisconnectReason.loggedOut) {
                      // 已登出：刪除存檔的 auth 資料
                      try { fs.rmSync(waAuthDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    }
                    let closeMsg: string;
                    if (statusCode === DisconnectReason.loggedOut) {
                      closeMsg = '⚠️ 已登出 WhatsApp（帳號在其他裝置登出）';
                    } else if (statusCode === 405) {
                      closeMsg = `❌ WhatsApp 拒絕連線 (multideviceMismatch 405)\n請確認手機 WhatsApp 已開啟多裝置功能：\n設定 → 已連結的裝置 → 多裝置測試版${errMsg ? '\n錯誤：' + errMsg : ''}`;
                    } else if (statusCode === 428) {
                      closeMsg = `❌ 連線被關閉 (428 connectionClosed)${errMsg ? '\n' + errMsg : ''}`;
                    } else if (statusCode === 500) {
                      closeMsg = `❌ 連線會話錯誤 (500 badSession)，請重新呼叫 whatsapp_connect${errMsg ? '\n' + errMsg : ''}`;
                    } else {
                      closeMsg = `❌ 連線已中斷 (code: ${statusCode ?? 'unknown'})${errMsg ? '\n' + errMsg : ''}`;
                    }
                    // 在 QR modal 顯示錯誤（若 QR 還顯示中）
                    this._cb.postToWebview({ type: 'waQrCode', imgDataUrl: '', statusMsg: closeMsg });
                    // 2 秒後關閉 modal
                    setTimeout(() => { this._cb.postToWebview({ type: 'waDisconnected' }); }, 2000);
                    if (this._waPendingQr) {
                      this._waPendingQr(closeMsg);
                      this._waPendingQr = null;
                    }
                  }
                });
                sockEv.on('creds.update', saveCreds as (...a: unknown[]) => void);

                // 接收訊息
                sockEv.on('messages.upsert', async (...evArgs: unknown[]) => {
                  const upsert = evArgs[0] as { messages: Record<string, unknown>[]; type: string };
                  this._cb.log(`WA upsert [connect] type=${upsert.type} count=${upsert.messages?.length}`);
                  for (const msg of upsert.messages) {
                    const k = msg['key'] as Record<string,unknown> | undefined;
                    const fromMe = !!(k?.['fromMe']);
                    const remoteJid = String(k?.['remoteJid'] ?? '');
                    this._cb.log(`WA msg: fromMe=${fromMe} jid=${remoteJid} type=${upsert.type}`);
                    if (upsert.type !== 'notify' && !fromMe) { continue; }
                    this.handleIncoming(msg).catch(e => this._cb.log('WA handleIncoming error: ' + String(e)));
                  }
                });
              };

              await startSock();
              // 90 秒掃描逾時
              setTimeout(() => {
                if (this._waPendingQr) {
                  this._cb.postToWebview({ type: 'waDisconnected' });
                  try { (this._waSock as Record<string, (...a: unknown[]) => unknown>)?.end?.(undefined); } catch { /* ignore */ }
                  this._waSock = null; this._waConnecting = false;
                  this._waPendingQr('⏱ QR Code 掃描逾時（90 秒），請重新呼叫 whatsapp_connect');
                  this._waPendingQr = null;
                }
              }, 90_000);
            } catch (e) {
              this._waConnecting = false;
              const msg = '❌ 無法啟動 WhatsApp Web：' + String(e) + '\n請確認套件已安裝並重新打包 .vsix';
              if (this._waPendingQr) { this._waPendingQr(msg); this._waPendingQr = null; } else resolve(msg);
            }
          }).catch(e => {
            this._waConnecting = false;
            const msg = '❌ 無法載入 Baileys 模組：' + String(e) + '\n請確認套件已安裝並重新打包 .vsix';
            if (this._waPendingQr) { this._waPendingQr(msg); this._waPendingQr = null; } else resolve(msg);
          });
          } catch (outerErr) {
            this._waConnecting = false;
            const msg = '❌ 初始化 WhatsApp 失敗：' + String(outerErr);
            if (this._waPendingQr) { this._waPendingQr(msg); this._waPendingQr = null; } else resolve(msg);
            this._cb.postToWebview({ type: 'waDisconnected' });
          }
        });
      }

      case 'whatsapp_status': {
        const waAuthDir2 = path.join(this._context.globalStorageUri.fsPath, 'wa-auth');
        const hasCredsFile = fs.existsSync(path.join(waAuthDir2, 'wa-auth', 'creds.json')) ||
                             fs.existsSync(path.join(waAuthDir2, 'creds.json'));
        const savedPhone2 = this._context.globalState.get<string>('amiAiClaw.waPhone', '');
        const sockAlive = !!this._waSock;
        const lines = [
          `_waConnected  : ${this._waConnected}`,
          `_waConnecting : ${this._waConnecting}`,
          `_waSock alive : ${sockAlive}`,
          `creds.json    : ${hasCredsFile}`,
          `saved phone   : ${savedPhone2 || '(無)'}`,
          `agentRunning  : ${this._cb.isAgentRunning()}`,
        ];
        return '📊 WhatsApp 狀態\n' + lines.join('\n');
      }

      case 'whatsapp_disconnect': {
        if (!this._waConnected && !this._waConnecting && !this._waSock) return '⚠️ WhatsApp Web 目前未連線';
        await this.disconnect();
        return '✅ 已中斷 WhatsApp Web 連線';
      }

      case 'whatsapp_save_credentials': {
        const saveToken = (args.access_token as string || '').trim();
        const savePhoneId = (args.phone_number_id as string || '').trim();
        if (!saveToken) return '請提供 access_token';
        if (!savePhoneId) return '請提供 phone_number_id';
        await this._context.globalState.update('amiAiClaw.waToken', saveToken);
        await this._context.globalState.update('amiAiClaw.waPhoneId', savePhoneId);
        return `✅ 已儲存 WhatsApp 憑證到 VS Code（僅本機儲存）\nPhone Number ID: ${savePhoneId}\nAccess Token: ${saveToken.slice(0, 8)}…（已隱藏）\n\n現在可以使用 whatsapp_send 和 whatsapp_send_template，無需手動設定 settings.json。`;
      }

      case 'whatsapp_send': {
        const waTo = ((args.to as string) || '').replace(/[\s\-()]/g, '');
        if (!waTo) return '請提供收件人電話號碼（to），含國碼，例如 +886912345678';
        const waMsg = (args.message as string || '').trim();
        if (!waMsg) return '請提供訊息內容（message）';
        // 加上 [AmiClaw] 標頭（若未包含）
        const waMsgFinal = waMsg.startsWith('[AmiClaw]') ? waMsg : `[AmiClaw] ${waMsg}`;
        const waAllowed = await this._cb.requestPermission('run', `發送 WhatsApp 訊息至 ${waTo}: ${waMsgFinal.slice(0, 80)}`, 'whatsapp_send');
        if (!waAllowed) return '使用者已拒絕發送 WhatsApp 訊息';
        // --- WA Web (QR 綁定) 模式優先 ---
        if (this._waConnected && this._waSock) {
          try {
            const jid = `${waTo.replace(/^\+/, '')}@s.whatsapp.net`;
            await (this._waSock as Record<string, (...a: unknown[]) => unknown>).sendMessage(jid, { text: waMsgFinal });
            return `✅ WhatsApp 訊息已發送至 ${args.to as string}（透過 QR 綁定連線）`;
          } catch (e) { return `❌ 發送失敗：${String(e)}`; }
        }
        // --- Meta Business API 模式（Access Token fallback）---
        const waToCfg = vscode.workspace.getConfiguration('amiAiClaw');
        // 優先從 globalState 讀（QR 連線後自動儲存），其次才看 settings
        const waToken = (this._context.globalState.get<string>('amiAiClaw.waToken', '') || waToCfg.get<string>('whatsappAccessToken', '')).trim();
        const waPhoneId = (this._context.globalState.get<string>('amiAiClaw.waPhoneId', '') || waToCfg.get<string>('whatsappPhoneNumberId', '')).trim();
        const waApiVer = waToCfg.get<string>('whatsappApiVersion', 'v20.0').trim();
        if (!waToken) return '請先使用 whatsapp_connect 掃描 QR Code 綁定，或在設定中配置 amiAiClaw.whatsappAccessToken（Meta Business API）';
        if (!waPhoneId) return '請先在設定中配置 amiAiClaw.whatsappPhoneNumberId（Meta 商業管理平台 Phone Number ID）';
        const waBody = JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: waTo,
          type: 'text',
          text: { preview_url: false, body: waMsgFinal }
        });
        return new Promise<string>(resolve => {
          const waBuf = Buffer.from(waBody, 'utf8');
          const waOpts = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/${waApiVer}/${waPhoneId}/messages`,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${waToken}`,
              'Content-Type': 'application/json',
              'Content-Length': waBuf.length
            }
          };
          let waBufResp = '';
          const waReq = https.request(waOpts, res => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { waBufResp += d; });
            res.on('end', () => {
              try {
                const j = JSON.parse(waBufResp) as Record<string, unknown>;
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  const msgs = j.messages as Array<{ id: string }> | undefined;
                  resolve(`✅ WhatsApp 訊息已發送成功至 ${waTo}${msgs?.[0]?.id ? ' (message_id: ' + msgs[0].id + ')' : ''}`);
                } else {
                  const err = j.error as Record<string, unknown> | undefined;
                  resolve(`發送失敗 HTTP ${res.statusCode}: ${err?.message ?? waBufResp.slice(0, 300)}`);
                }
              } catch { resolve(`HTTP ${res.statusCode} 回應解析失敗: ${waBufResp.slice(0, 300)}`); }
            });
          });
          waReq.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          waReq.setTimeout(15000, () => { waReq.destroy(); resolve('超時 (15s)'); });
          waReq.write(waBuf);
          waReq.end();
        });
      }

      case 'whatsapp_send_template': {
        const wtCfg = vscode.workspace.getConfiguration('amiAiClaw');
        // 優先從 globalState 讀（QR 連線後自動儲存），其次才看 settings
        const wtToken = (this._context.globalState.get<string>('amiAiClaw.waToken', '') || wtCfg.get<string>('whatsappAccessToken', '')).trim();
        const wtPhoneId = (this._context.globalState.get<string>('amiAiClaw.waPhoneId', '') || wtCfg.get<string>('whatsappPhoneNumberId', '')).trim();
        const wtApiVer = wtCfg.get<string>('whatsappApiVersion', 'v20.0').trim();
        if (!wtToken) return '請先使用 whatsapp_connect 掃描 QR Code 綁定，或在設定中配置 amiAiClaw.whatsappAccessToken';
        if (!wtPhoneId) return '請先使用 whatsapp_connect 掃描 QR Code 綁定，或在設定中配置 amiAiClaw.whatsappPhoneNumberId';
        const wtTo = ((args.to as string) || '').replace(/[\s\-()]/g, '');
        if (!wtTo) return '請提供收件人電話號碼（to）';
        const wtTpl = (args.template_name as string || '').trim();
        if (!wtTpl) return '請提供樣板名稱（template_name）';
        const wtLang = (args.language_code as string || 'zh_TW').trim();
        const wtParams = args.body_params as string[] | undefined;
        const wtAllowed = await this._cb.requestPermission('run', `發送 WhatsApp 樣板 [${wtTpl}] 至 ${wtTo}`, 'whatsapp_send_template');
        if (!wtAllowed) return '使用者已拒絕發送 WhatsApp 樣板訊息';
        const wtBodyComp: Record<string, unknown>[] = [];
        if (wtParams && wtParams.length > 0) {
          wtBodyComp.push({ type: 'body', parameters: wtParams.map(v => ({ type: 'text', text: v })) });
        }
        const wtPayload: Record<string, unknown> = {
          messaging_product: 'whatsapp',
          to: wtTo,
          type: 'template',
          template: {
            name: wtTpl,
            language: { code: wtLang },
            ...(wtBodyComp.length > 0 ? { components: wtBodyComp } : {})
          }
        };
        return new Promise<string>(resolve => {
          const wtBuf = Buffer.from(JSON.stringify(wtPayload), 'utf8');
          const wtOpts = {
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/${wtApiVer}/${wtPhoneId}/messages`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${wtToken}`, 'Content-Type': 'application/json', 'Content-Length': wtBuf.length }
          };
          let wtResp = '';
          const wtReq = https.request(wtOpts, res => {
            res.setEncoding('utf8');
            res.on('data', (d: string) => { wtResp += d; });
            res.on('end', () => {
              try {
                const j = JSON.parse(wtResp) as Record<string, unknown>;
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  const msgs = j.messages as Array<{ id: string }> | undefined;
                  resolve(`✅ WhatsApp 樣板 [${wtTpl}] 已發送成功至 ${wtTo}${msgs?.[0]?.id ? ' (message_id: ' + msgs[0].id + ')' : ''}`);
                } else {
                  const err = j.error as Record<string, unknown> | undefined;
                  resolve(`發送失敗 HTTP ${res.statusCode}: ${err?.message ?? wtResp.slice(0, 300)}`);
                }
              } catch { resolve(`HTTP ${res.statusCode} 回應解析失敗: ${wtResp.slice(0, 300)}`); }
            });
          });
          wtReq.on('error', (e: Error) => resolve(`網路錯誤: ${e.message}`));
          wtReq.setTimeout(15000, () => { wtReq.destroy(); resolve('超時 (15s)'); });
          wtReq.write(wtBuf);
          wtReq.end();
        });
      }

      default:
        return `未知 WhatsApp 工具: ${name}`;
    }
  }

  // ── Private static utilities (copied from ollama-chat.ts to avoid circular imports) ──

  /** 讀取所有設定的 Ollama 伺服器 URL（amiAiClaw.urls）。 */
  private static _getOllamaUrls(cfg: vscode.WorkspaceConfiguration): string[] {
    const arr = (cfg.get<string[]>('urls') ?? []).filter((u: string) => u.trim());
    if (arr.length > 0) {
      // 重複出現的 URL 視為停用：只保留恰好出現一次的 URL
      const count = new Map<string, number>();
      for (const u of arr) count.set(u, (count.get(u) ?? 0) + 1);
      const enabled = arr.filter(u => count.get(u) === 1);
      return enabled.length > 0 ? enabled : [];
    }
    return [cfg.get<string>('url') ?? 'http://localhost:11434'];
  }

  /** 編碼 Ollama model ID：多伺服器時加 URL 前綴，單伺服器時返回原始 model 名稱（向後相容）。 */
  private static _encodeOllamaModelId(url: string, model: string, allUrls: string[]): string {
    return allUrls.length > 1 ? `${url}||${model}` : model;
  }

  /** 顯示標籤：多伺服器時加上 [hostname:port] 前綴。 */
  private static _ollamaDisplayLabel(url: string, model: string, allUrls: string[]): string {
    if (allUrls.length <= 1) return model;
    try { const u = new URL(url); return `[${u.hostname}:${u.port || '11434'}] ${model}`; } catch { return model; }
  }

  /** GET /api/tags → 傳回模型名稱清單。 */
  private static _ollamaListModels(baseUrl: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL('/api/tags', baseUrl);
        const protocol = url.protocol === 'https:' ? https : http;
        const options: http.RequestOptions = {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 11434),
          path: url.pathname,
          method: 'GET',
        };
        const req = protocol.request(options, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
            try {
              const json = JSON.parse(data);
              const names: string[] = (json.models ?? []).map((m: { name: string }) => m.name).sort();
              resolve(names);
            } catch { reject(new Error('Invalid JSON from /api/tags')); }
          });
        });
        req.on('error', (e: NodeJS.ErrnoException) => reject(WhatsAppManager._ollamaConnectError(url.hostname, e)));
        req.setTimeout(8000, () => { req.destroy(new Error('ETIMEDOUT')); });
        req.end();
      } catch (e) { reject(e); }
    });
  }

  private static _ollamaConnectError(hostname: string, e: NodeJS.ErrnoException): Error {
    if (e.code === 'ENOTFOUND') {
      return new Error('主機名稱 \'' + hostname + '\' 無法解析（DNS），請確認 /etc/hosts 或 DNS 設定');
    }
    if (e.code === 'ECONNREFUSED') {
      return new Error('連線被拒絕（port 未開放），請確認 Ollama 伺服器已啟動：' + hostname + ':11434');
    }
    if (e.code === 'ETIMEDOUT' || e.message === 'ETIMEDOUT') {
      return new Error('連線逾時，請確認防火牆設定或主機 \'' + hostname + '\' 可達');
    }
    if (e.code === 'EHOSTUNREACH') {
      return new Error('無法到達主機 \'' + hostname + '\'，請確認網路路由設定');
    }
    return new Error((e.code ? e.code + ': ' : '') + e.message);
  }
}
