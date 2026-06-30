// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

/**
 * 工具結果快取：TTL 內回傳上次值，過期自動失效。
 */
export class ToolCache {
  private _map = new Map<string, { value: string; ts: number }>();

  public constructor(private readonly _ttlMs: number = 30_000) {}

  public get(key: string): string | undefined {
    const entry = this._map.get(key);
    if (!entry) { return undefined; }
    if (Date.now() - entry.ts > this._ttlMs) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(key: string, value: string): void {
    this._map.set(key, { value, ts: Date.now() });
  }

  public delete(key: string): void {
    this._map.delete(key);
  }

  public clear(): void {
    this._map.clear();
  }
}
