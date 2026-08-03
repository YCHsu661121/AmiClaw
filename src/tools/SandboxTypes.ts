// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/** 工具執行模式：host = 直接寫入工作區；shadow = 寫入隔離暫存區等待審核 */
export type SandboxMode = 'host' | 'shadow';

/** 影子暫存區中單一檔案的狀態 */
export interface ShadowFileEntry {
  /** 真實工作區絕對路徑 */
  original: string;
  /** 暫存區絕對路徑 */
  shadow: string;
  /** 操作類型 */
  op: 'write' | 'replace' | 'insert' | 'delete' | 'rename';
  /** 已通過驗證 */
  verified: boolean;
}

/** 影子工作區整體狀態 */
export interface ShadowWorkspaceState {
  status: 'idle' | 'staging' | 'verifying' | 'ready_to_commit' | 'committed' | 'rolled_back';
  shadowDir: string;
  files: ShadowFileEntry[];
  verifyOutput?: string;
  verifyPassed?: boolean;
}

/** 驗證結果 */
export interface SandboxVerifyResult {
  passed: boolean;
  output: string;
  errors: Array<{ file: string; message: string; line?: number }>;
}

/** ISandboxManager：影子工作區管理介面 */
export interface ISandboxManager {
  /** 是否處於活動的影子模式（staging / verifying / ready_to_commit） */
  isActive(): boolean;
  /** 取得目前完整狀態快照 */
  getState(): ShadowWorkspaceState;
  /**
   * 初始化影子工作區（建立 temp 目錄）。
   * 可重複呼叫——若已有活動 session 則清除後重建。
   */
  initShadow(sessionId: string): void;
  /** 將真實路徑映射至影子路徑 */
  mapToShadow(originalPath: string): string;
  /** 記錄一次影子區變更 */
  recordChange(entry: Omit<ShadowFileEntry, 'verified'>): void;
  /** 執行編譯 + lint 驗證；更新 state.status */
  verify(): Promise<SandboxVerifyResult>;
  /** 將影子區變更寫回真實工作區；回傳已提交的路徑清單 */
  commit(): Promise<string[]>;
  /** 清除影子區，不影響真實工作區 */
  rollback(): void;
}
