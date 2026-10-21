export const setupStages = ['preflight', 'credentials', 'install', 'connection'] as const;
export type SetupStage = typeof setupStages[number];
type StageStatus = 'pending' | 'completed' | 'failed' | 'skipped';
export interface SetupProgressEvent {
  type: 'steercards-setup-progress';
  stage: SetupStage;
  status: 'started' | Exclude<StageStatus, 'pending'>;
  elapsedMs: number;
  durationMs?: number;
}
export interface SetupTimings {
  totalMs: number;
  stages: Record<SetupStage, { status: StageStatus; durationMs: number }>;
}

/** Emits only fixed stage/status identifiers and monotonic durations, never input data. */
export class SetupProgress {
  private readonly began = performance.now();
  private active?: { stage: SetupStage; began: number };
  readonly timings: SetupTimings = {
    totalMs: 0,
    stages: Object.fromEntries(setupStages.map(stage => [stage, { status: 'pending', durationMs: 0 }])) as SetupTimings['stages'],
  };
  constructor(private readonly emit?: (event: SetupProgressEvent) => void) {}
  private elapsed() { return Math.max(0, Math.round(performance.now() - this.began)); }
  start(stage: SetupStage) {
    this.active = { stage, began: performance.now() };
    this.emit?.({ type: 'steercards-setup-progress', stage, status: 'started', elapsedMs: this.elapsed() });
  }
  finish(status: Exclude<StageStatus, 'pending'> = 'completed') {
    if (!this.active) return;
    const { stage, began } = this.active;
    const durationMs = Math.max(0, Math.round(performance.now() - began));
    this.timings.stages[stage] = { status, durationMs };
    this.active = undefined;
    this.emit?.({ type: 'steercards-setup-progress', stage, status, elapsedMs: this.elapsed(), durationMs });
  }
  skip(stage: SetupStage) { this.start(stage); this.finish('skipped'); }
  complete() { this.timings.totalMs = this.elapsed(); }
}
