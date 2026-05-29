import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() => vi.fn());
const tmuxCalls = vi.hoisted(() => [] as string[][]);

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

async function writeJson(cwd: string, relativePath: string, value: unknown): Promise<void> {
  const fullPath = join(cwd, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(value, null, 2), 'utf-8');
}

describe('cleanupDeadWorkerPanes', () => {
  let cwd = '';

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'omc-runtime-v2-dead-pane-cleanup-'));
    tmuxCalls.length = 0;
    execFileMock.mockReset();

    const run = (args: string[]) => {
      tmuxCalls.push(args);
      let stdout = '';
      if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
        // Default: pane is dead
        stdout = '1\n';
      }
      return { stdout, stderr: '' };
    };

    execFileMock.mockImplementation((_cmd: string, args: string[], cb?: ExecFileCallback) => {
      const { stdout, stderr } = run(args);
      if (cb) cb(null, stdout, stderr);
      return {} as never;
    });
    (execFileMock as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
      async (_cmd: string, args: string[]) => run(args);
  });

  afterEach(async () => {
    tmuxCalls.length = 0;
    execFileMock.mockReset();
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = '';
    }
  });

  it('kills panes of dead workers and requeues their in-progress tasks', async () => {
    const teamName = 'dead-cleanup-team';
    const teamRoot = `.omc/state/team/${teamName}`;

    // Write team config with 2 workers, each with a pane
    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 2,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'], pane_id: '%2' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: ['2'], pane_id: '%3' },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_window_owned: false,
      next_task_id: 3,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    // Write task files — worker-1 has an in-progress task
    // Note: normalizeTaskFileStem('1') → 'task-1', so files are task-N.json
    await writeJson(cwd, `${teamRoot}/tasks/task-1.json`, {
      id: '1',
      subject: 'Task 1',
      description: 'First task',
      status: 'in_progress',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
    });
    await writeJson(cwd, `${teamRoot}/tasks/task-2.json`, {
      id: '2',
      subject: 'Task 2',
      description: 'Second task',
      status: 'completed',
      owner: 'worker-2',
      created_at: new Date().toISOString(),
    });

    const { cleanupDeadWorkerPanes } = await import('../runtime-v2.js');
    const result = await cleanupDeadWorkerPanes(teamName, ['worker-1'], cwd);

    // Should have killed worker-1's pane (%2) but not leader (%1) or worker-2 (%3)
    const killPaneTargets = tmuxCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);
    expect(killPaneTargets).toContain('%2');
    expect(killPaneTargets).not.toContain('%1');
    expect(killPaneTargets).not.toContain('%3');

    // Should have requeued task 1
    expect(result.requeuedTaskIds).toContain('1');

    // Verify task 1 status was reset to pending
    const task1Raw = await readFile(join(cwd, teamRoot, 'tasks', 'task-1.json'), 'utf-8');
    const task1 = JSON.parse(task1Raw);
    expect(task1.status).toBe('pending');
    expect(task1.owner).toBeUndefined();
  });

  it('kills panes of multiple dead workers simultaneously', async () => {
    const teamName = 'multi-dead-team';
    const teamRoot = `.omc/state/team/${teamName}`;

    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 3,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'], pane_id: '%2' },
        { name: 'worker-2', index: 2, role: 'claude', assigned_tasks: ['2'], pane_id: '%3' },
        { name: 'worker-3', index: 3, role: 'claude', assigned_tasks: ['3'], pane_id: '%4' },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_window_owned: false,
      next_task_id: 4,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    // All three workers have in-progress tasks
    for (let i = 1; i <= 3; i++) {
      await writeJson(cwd, `${teamRoot}/tasks/task-${i}.json`, {
        id: String(i),
        subject: `Task ${i}`,
        description: `Task ${i} description`,
        status: 'in_progress',
        owner: `worker-${i}`,
        created_at: new Date().toISOString(),
      });
    }

    const { cleanupDeadWorkerPanes } = await import('../runtime-v2.js');
    const result = await cleanupDeadWorkerPanes(teamName, ['worker-1', 'worker-3'], cwd);

    const killPaneTargets = tmuxCalls
      .filter((args) => args[0] === 'kill-pane')
      .map((args) => args[2]);

    // Should kill panes of worker-1 and worker-3 only
    expect(killPaneTargets).toContain('%2');
    expect(killPaneTargets).toContain('%4');
    expect(killPaneTargets).not.toContain('%1'); // leader
    expect(killPaneTargets).not.toContain('%3'); // alive worker-2

    // Should have requeued tasks 1 and 3
    expect(result.requeuedTaskIds).toEqual(expect.arrayContaining(['1', '3']));
    expect(result.requeuedTaskIds).not.toContain('2');
  });

  it('does nothing when dead worker list is empty', async () => {
    const teamName = 'no-dead-team';
    const teamRoot = `.omc/state/team/${teamName}`;

    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'], pane_id: '%2' },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_window_owned: false,
      next_task_id: 2,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    const { cleanupDeadWorkerPanes } = await import('../runtime-v2.js');
    const result = await cleanupDeadWorkerPanes(teamName, [], cwd);

    const killPaneCalls = tmuxCalls.filter((args) => args[0] === 'kill-pane');
    expect(killPaneCalls).toHaveLength(0);
    expect(result.requeuedTaskIds).toEqual([]);
    expect(result.killedPaneIds).toEqual([]);
  });

  it('skips workers that have no pane_id in config', async () => {
    const teamName = 'no-pane-team';
    const teamRoot = `.omc/state/team/${teamName}`;

    await writeJson(cwd, `${teamRoot}/config.json`, {
      name: teamName,
      task: 'demo',
      agent_type: 'claude',
      worker_launch_mode: 'interactive',
      worker_count: 1,
      max_workers: 20,
      workers: [
        { name: 'worker-1', index: 1, role: 'claude', assigned_tasks: ['1'] },
      ],
      created_at: new Date().toISOString(),
      tmux_session: 'leader-session:0',
      tmux_window_owned: false,
      next_task_id: 2,
      leader_pane_id: '%1',
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    });

    await writeJson(cwd, `${teamRoot}/tasks/task-1.json`, {
      id: '1',
      subject: 'Task 1',
      description: 'First task',
      status: 'in_progress',
      owner: 'worker-1',
      created_at: new Date().toISOString(),
    });

    const { cleanupDeadWorkerPanes } = await import('../runtime-v2.js');
    const result = await cleanupDeadWorkerPanes(teamName, ['worker-1'], cwd);

    // No pane to kill, but task should still be requeued
    const killPaneCalls = tmuxCalls.filter((args) => args[0] === 'kill-pane');
    expect(killPaneCalls).toHaveLength(0);
    expect(result.killedPaneIds).toEqual([]);
    expect(result.requeuedTaskIds).toContain('1');
  });
});
