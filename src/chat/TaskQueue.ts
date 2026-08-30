// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.

export interface QueuedTask {
  id: string;
  prompt: string;
  modelOverride?: string;
  addedAt: number;
}

export class TaskQueue {
  private _items: QueuedTask[] = [];
  private _seq = 0;

  enqueue(prompt: string, modelOverride?: string): QueuedTask {
    const task: QueuedTask = {
      id: `q-${++this._seq}`,
      prompt: prompt.trim(),
      modelOverride: modelOverride?.trim() || undefined,
      addedAt: Date.now(),
    };
    this._items.push(task);
    return task;
  }

  dequeue(): QueuedTask | undefined {
    return this._items.shift();
  }

  peek(): QueuedTask | undefined {
    return this._items[0];
  }

  get length(): number {
    return this._items.length;
  }

  getAll(): readonly QueuedTask[] {
    return [...this._items];
  }

  remove(id: string): boolean {
    const idx = this._items.findIndex(t => t.id === id);
    if (idx < 0) return false;
    this._items.splice(idx, 1);
    return true;
  }

  clear(): number {
    const count = this._items.length;
    this._items = [];
    return count;
  }

  format(): string {
    if (!this._items.length) return '（任務佇列為空）';
    return this._items.map((t, i) => {
      const prompt = t.prompt.length > 80 ? t.prompt.slice(0, 80) + '…' : t.prompt;
      const model = t.modelOverride ? ` [${t.modelOverride}]` : '';
      return `${i + 1}. [${t.id}]${model} ${prompt}`;
    }).join('\n');
  }
}
