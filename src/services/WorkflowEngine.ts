// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// WorkflowEngine — save / load / list / run named multi-step agent workflows.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface WorkflowStep {
  prompt: string;
  description?: string;
}

export interface Workflow {
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  lastRun?: string;
  runCount?: number;
}

function getWorkflowsDir(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders[0]?.uri.fsPath ?? process.env['HOME'] ?? '.';
  return path.join(root, '.amiclaw', 'workflows');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 60);
}

export async function saveWorkflow(workflow: Workflow): Promise<void> {
  const dir = getWorkflowsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeName(workflow.name)}.json`);
  await fs.writeFile(file, JSON.stringify(workflow, null, 2), 'utf8');
}

export async function loadWorkflow(name: string): Promise<Workflow | null> {
  const file = path.join(getWorkflowsDir(), `${sanitizeName(name)}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as Workflow;
  } catch { return null; }
}

export async function listWorkflows(): Promise<Workflow[]> {
  const dir = getWorkflowsDir();
  try {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    const results = await Promise.all(files.map(async f => {
      try { return JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as Workflow; }
      catch { return null; }
    }));
    return results.filter((w): w is Workflow => w !== null);
  } catch { return []; }
}

export async function deleteWorkflow(name: string): Promise<void> {
  const file = path.join(getWorkflowsDir(), `${sanitizeName(name)}.json`);
  try { await fs.unlink(file); } catch { /* ignore */ }
}

/** Build a coordinator prompt that runs a workflow's steps in sequence. */
export function buildWorkflowCoordinatorPrompt(workflow: Workflow): string {
  const stepList = workflow.steps.map((s, i) =>
    `步驟 ${i + 1}${s.description ? ' — ' + s.description : ''}：${s.prompt}`
  ).join('\n');
  return `執行工作流程「${workflow.name}」：\n${workflow.description}\n\n請依序執行以下 ${workflow.steps.length} 個步驟，每個步驟用 spawn_worker 委派執行：\n\n${stepList}\n\n所有步驟完成後呼叫 coordinator_done 並摘要結果。`;
}
