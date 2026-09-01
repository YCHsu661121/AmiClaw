// Copyright (c) 2026 YCHsu. All rights reserved.
// Licensed under the MIT License.
// WorkflowEngine — save / load / list / run named multi-step agent workflows.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { createHash } from 'crypto';

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

// ── Run state (resume / cancel) ───────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface StepResult {
  stepIndex: number;
  description?: string;
  status: 'completed' | 'failed' | 'skipped';
  summary?: string;
  completedAt: string;
}

export interface WorkflowRun {
  runId: string;
  workflowName: string;
  /** SHA-256 of the workflow definition at run creation — used to detect definition changes on resume. */
  workflowHash: string;
  status: RunStatus;
  /** 0-based index of the NEXT step to execute. */
  currentStep: number;
  totalSteps: number;
  stepResults: StepResult[];
  startedAt: string;
  updatedAt: string;
  error?: string;
}

function getWorkflowsDir(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const root = folders[0]?.uri.fsPath ?? process.env['HOME'] ?? '.';
  return path.join(root, '.amiclaw', 'workflows');
}

function getRunsDir(): string {
  return path.join(getWorkflowsDir(), 'runs');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_').slice(0, 60);
}

function workflowHash(wf: Workflow): string {
  return createHash('sha256')
    .update(JSON.stringify(wf.steps))
    .digest('hex')
    .slice(0, 12);
}

// ── Workflow CRUD ─────────────────────────────────────────────────────────────

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

// ── Run persistence (resume / cancel) ────────────────────────────────────────

export async function createRun(wf: Workflow): Promise<WorkflowRun> {
  const runsDir = getRunsDir();
  await fs.mkdir(runsDir, { recursive: true });
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const run: WorkflowRun = {
    runId, workflowName: wf.name, workflowHash: workflowHash(wf),
    status: 'running', currentStep: 0, totalSteps: wf.steps.length,
    stepResults: [], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await _saveRun(run);
  // Update workflow's lastRun + runCount
  wf.lastRun = run.startedAt;
  wf.runCount = (wf.runCount ?? 0) + 1;
  await saveWorkflow(wf);
  return run;
}

export async function loadRun(runId: string): Promise<WorkflowRun | null> {
  try {
    const raw = await fs.readFile(path.join(getRunsDir(), `${runId}.json`), 'utf8');
    return JSON.parse(raw) as WorkflowRun;
  } catch { return null; }
}

export async function listRuns(workflowName?: string): Promise<WorkflowRun[]> {
  const dir = getRunsDir();
  try {
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    const runs = await Promise.all(files.map(async f => {
      try { return JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as WorkflowRun; }
      catch { return null; }
    }));
    const valid = runs.filter((r): r is WorkflowRun => r !== null);
    const filtered = workflowName ? valid.filter(r => r.workflowName === workflowName) : valid;
    return filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch { return []; }
}

/** Record a step completion and advance currentStep. */
export async function saveRunStep(runId: string, result: StepResult): Promise<WorkflowRun | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  // Replace if already present (idempotent), otherwise append
  const idx = run.stepResults.findIndex(r => r.stepIndex === result.stepIndex);
  if (idx >= 0) { run.stepResults[idx] = result; } else { run.stepResults.push(result); }
  run.currentStep = Math.max(run.currentStep, result.stepIndex + 1);
  if (result.status === 'failed') { run.status = 'paused'; run.error = result.summary; }
  run.updatedAt = new Date().toISOString();
  await _saveRun(run);
  return run;
}

/** Mark a run as completed / failed / cancelled. */
export async function finalizeRun(runId: string, status: Exclude<RunStatus, 'running' | 'paused'>, error?: string): Promise<void> {
  const run = await loadRun(runId);
  if (!run) return;
  run.status = status;
  if (error) run.error = error;
  run.updatedAt = new Date().toISOString();
  await _saveRun(run);
}

export async function cancelRun(runId: string): Promise<WorkflowRun | null> {
  const run = await loadRun(runId);
  if (!run) return null;
  if (run.status !== 'running' && run.status !== 'paused') return run;
  run.status = 'cancelled';
  run.updatedAt = new Date().toISOString();
  await _saveRun(run);
  return run;
}

async function _saveRun(run: WorkflowRun): Promise<void> {
  const dir = getRunsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${run.runId}.json`), JSON.stringify(run, null, 2), 'utf8');
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/** Build a coordinator prompt that runs a workflow's steps in sequence.
 *  When `run` is supplied, skips already-completed steps and shows progress. */
export function buildWorkflowCoordinatorPrompt(workflow: Workflow, run?: WorkflowRun): string {
  const doneSet = new Set((run?.stepResults ?? [])
    .filter(r => r.status === 'completed')
    .map(r => r.stepIndex));
  const startFrom = run?.currentStep ?? 0;
  const runIdNote = run ? `\n[RunID: ${run.runId} — 完成後請呼叫 workflow_step_done 回報每步結果]` : '';
  const resumeNote = startFrom > 0
    ? `\n⚠️ 已完成步驟 1–${startFrom}（共 ${workflow.steps.length} 步），從步驟 ${startFrom + 1} 繼續執行。`
    : '';

  const stepList = workflow.steps.map((s, i) => {
    const done = doneSet.has(i);
    const prefix = done ? `~~步驟 ${i + 1}~~（已完成）` : `步驟 ${i + 1}${s.description ? ' — ' + s.description : ''}`;
    return done ? prefix : `${prefix}：${s.prompt}`;
  }).join('\n');

  return `執行工作流程「${workflow.name}」：\n${workflow.description}${resumeNote}${runIdNote}\n\n請依序執行以下 ${workflow.steps.length} 個步驟${startFrom > 0 ? `（跳過已完成的步驟 1–${startFrom}）` : ''}，每個步驟用 spawn_worker 委派執行：\n\n${stepList}\n\n每個步驟完成後，呼叫 workflow_step_done(run_id="${run?.runId ?? ''}", step_index=<步驟索引>, summary=<摘要>, status="completed"|"failed")。所有步驟完成後呼叫 coordinator_done 並摘要結果。`;
}

