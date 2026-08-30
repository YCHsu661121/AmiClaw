// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

export type TaskStatus = 'created' | 'claimed' | 'completed' | 'failed' | 'blocked';

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  context?: string;
  result?: string;       // Worker's report_result summary
  errorDetails?: string;
  workerIdx?: number;
  createdAt: number;
  claimedAt?: number;
  resolvedAt?: number;
}

const STATUS_ICON: Record<TaskStatus, string> = {
  created: '⬜', claimed: '🔄', completed: '✅', failed: '❌', blocked: '⚠️',
};

export class TaskStore {
  private readonly _tasks = new Map<string, Task>();
  private _seq = 0;

  create(description: string, context?: string, id?: string): Task {
    const taskId = id?.trim() || `task-${++this._seq}`;
    const task: Task = { id: taskId, description, status: 'created', context, createdAt: Date.now() };
    this._tasks.set(taskId, task);
    return task;
  }

  /** Transitions created → claimed; no-op if task doesn't exist or is in wrong state. */
  claim(taskId: string, workerIdx: number): Task | undefined {
    const task = this._tasks.get(taskId);
    if (!task || task.status !== 'created') return undefined;
    task.status = 'claimed';
    task.workerIdx = workerIdx;
    task.claimedAt = Date.now();
    return task;
  }

  /** Transitions claimed → completed | failed | blocked. */
  resolve(taskId: string, status: 'completed' | 'failed' | 'blocked', result?: string, errorDetails?: string): void {
    const task = this._tasks.get(taskId);
    if (!task) return;
    task.status = status;
    task.result = result;
    task.errorDetails = errorDetails;
    task.resolvedAt = Date.now();
  }

  get(taskId: string): Task | undefined {
    return this._tasks.get(taskId);
  }

  getAll(): readonly Task[] {
    return Array.from(this._tasks.values());
  }

  /** Formatted task board for LLM / webview display. */
  format(): string {
    const tasks = this.getAll();
    if (!tasks.length) return '（無任務）';
    return tasks.map(t => {
      const lines = [`${STATUS_ICON[t.status]} [${t.id}] ${t.description}`];
      if (t.status === 'claimed' && t.workerIdx !== undefined)
        lines.push(`  → Worker #${t.workerIdx} 處理中`);
      if (t.result)
        lines.push(`  結果：${t.result.slice(0, 150)}`);
      if (t.errorDetails)
        lines.push(`  錯誤：${t.errorDetails.slice(0, 80)}`);
      return lines.join('\n');
    }).join('\n');
  }
}
