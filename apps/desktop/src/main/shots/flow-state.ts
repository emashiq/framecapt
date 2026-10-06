export type FlowPhase = 'idle' | 'preparing' | 'selecting' | 'capturing';

export type FlowStart = { ok: true; flowId: number } | { ok: false; code: 'BUSY' };

/**
 * Only one capture flow may run at a time. Every async step of a flow carries its `flowId` and
 * checks `isCurrent` before acting, so a cancelled or finished flow can never be resumed by a late
 * promise. `end` is idempotent: it returns true only for the call that actually ended the flow.
 */
export class FlowState {
  private nextId = 1;
  private currentId: number | undefined;
  private currentPhase: FlowPhase = 'idle';

  get phase(): FlowPhase {
    return this.currentPhase;
  }

  get active(): boolean {
    return this.currentId !== undefined;
  }

  tryStart(): FlowStart {
    if (this.currentId !== undefined) return { ok: false, code: 'BUSY' };
    this.currentId = this.nextId++;
    this.currentPhase = 'preparing';
    return { ok: true, flowId: this.currentId };
  }

  isCurrent(flowId: number): boolean {
    return this.currentId === flowId;
  }

  /** Moves a running flow to `phase`. Returns false when `flowId` is not the running flow. */
  setPhase(flowId: number, phase: Exclude<FlowPhase, 'idle'>): boolean {
    if (this.currentId !== flowId) return false;
    this.currentPhase = phase;
    return true;
  }

  end(flowId: number): boolean {
    if (this.currentId !== flowId) return false;
    this.currentId = undefined;
    this.currentPhase = 'idle';
    return true;
  }
}
