declare namespace Electron {
  interface MouseEvent {
    target?: AgentTarget;
  }
  interface KeyEvent {
    target?: AgentTarget;
  }
  interface TouchEvent {
    target?: AgentTarget;
  }
  interface ClickSelectorOptions {
    target?: AgentTarget;
  }
  interface QuerySelectorDeepOptions {
    agentInfo?: boolean;
  }
  interface AgentTarget {
    webContentsId: number;
    processId: number;
    routingId: number;
    documentId: number;
    backendNodeId: number;
  }
  interface AgentElement {
    target: AgentTarget;
    backendNodeId: number;
    parentBackendNodeId?: number;
    options?: {
      backendNodeId: number;
      label: string;
      text: string;
      value: string;
      selected: boolean;
      disabled: boolean;
    }[];
    tagName: string;
    type: string;
    role: string;
    name: string;
    text: string;
    value?: string;
    valueRedacted?: boolean;
    labelText: string;
    description?: string;
    placeholder: string;
    descriptionText: string;
    errorText: string;
    invalid: string;
    disabled?: boolean;
    readOnly?: boolean;
    checked?: string;
    selected?: boolean;
    expanded?: boolean;
    focused?: boolean;
    visible: boolean;
    bounds: Rectangle;
  }
  interface AgentSnapshotOptions {
    maxNodes?: number;
    maxFrames?: number;
    timeoutMs?: number;
    pierce?: boolean;
    selector?: string;
  }
  interface AgentFrameCoverage {
    processId: number;
    routingId: number;
    url: string;
    status: 'covered' | 'partial' | 'failed' | 'skipped';
    reason?: string;
    documentId?: number;
  }
  interface AgentSnapshot {
    complete: boolean;
    truncated: boolean;
    truncationReasons: string[];
    frames: AgentFrameCoverage[];
    elements: AgentElement[];
  }
  interface AgentFindQuery {
    selector?: string;
    role?: string;
    name?: string;
    text?: string;
    label?: string;
    disabled?: boolean;
    checked?: string;
    selected?: boolean;
  }
  interface AgentDispatchResult {
    status: 'dispatched' | 'failed';
    stage: 'target-resolution' | 'frame-routing' | 'event-dispatch';
    target?: AgentTarget;
    reason?: string;
    deliveryWarning?: string;
    stages: { stage: string; status: 'ok' | 'failed' }[];
  }
  interface VirtualCursorOptions {
    blockRealPointer?: boolean;
    blockRealKeyboard?: boolean;
  }
  interface VirtualCursorImageOptions {
    hotspot?: Point;
  }
  interface InputSequenceMouseStep extends Omit<MouseEvent, 'timestamp'> {
    kind: 'mouse';
    atMs: number;
    timestamp?: never;
  }
  interface InputSequenceKeyStep extends Omit<KeyEvent, 'timestamp'> {
    kind: 'key';
    atMs: number;
    timestamp?: never;
  }
  interface InputSequenceOptions {
    signal?: AbortSignal;
    queueTimeoutMs?: number;
    timeoutMs?: number;
    focusTimeoutMs?: number;
    maxLatenessMs?: number;
  }
  interface InputSequenceResult {
    status: 'completed' | 'cancelled' | 'failed';
    reason: string;
    dispatchedCount: number;
    mouseCount: number;
    keyCount: number;
    lastDispatchedIndex: number | null;
    stoppedIndex: number | null;
    queueMs: number;
    preparationMs: number;
    executionMs: number;
    lateness: { p50: number; p95: number; p99: number; max: number };
    cleanup: { dispatched: number; failed: number };
  }
  interface WebContents {
    setVirtualCursorEnabled(enabled: boolean, options?: VirtualCursorOptions): Promise<void>;
    setVirtualCursorImage(image: NativeImage | null, options?: VirtualCursorImageOptions): void;
    setVirtualCursorFrameRate(fps: number): void;
    dispatchInputSequence(
      steps: (InputSequenceMouseStep | InputSequenceKeyStep)[],
      options?: InputSequenceOptions
    ): Promise<InputSequenceResult>;
    getAgentSnapshot(options?: AgentSnapshotOptions): Promise<AgentSnapshot>;
    findAgentElements(query: AgentFindQuery, options?: AgentSnapshotOptions): Promise<AgentSnapshot>;
    dispatchMouseEvent(
      event: Omit<MouseEvent, 'x' | 'y'> & { target: AgentTarget; x?: number; y?: number }
    ): Promise<AgentDispatchResult>;
    dispatchKeyEvent(event: KeyEvent & { target: AgentTarget }): Promise<AgentDispatchResult>;
    dispatchTouchEvent(event: TouchEvent & { target: AgentTarget }): Promise<AgentDispatchResult>;
    clickSelector(
      selector: string,
      options: ClickSelectorOptions & { target: AgentTarget }
    ): Promise<AgentDispatchResult>;
    querySelectorAcrossDocuments(
      selector: string,
      options: QuerySelectorDeepOptions & { agentInfo: true }
    ): Promise<AgentSnapshot>;
  }

  namespace Common {
    interface VirtualCursorOptions extends Electron.VirtualCursorOptions {}
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    interface InputSequenceMouseStep extends Electron.InputSequenceMouseStep {}
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }

  namespace Main {
    interface VirtualCursorOptions extends Electron.VirtualCursorOptions {}
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    interface InputSequenceMouseStep extends Electron.InputSequenceMouseStep {}
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }

  namespace CrossProcessExports {
    interface VirtualCursorOptions extends Electron.VirtualCursorOptions {}
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    interface InputSequenceMouseStep extends Electron.InputSequenceMouseStep {}
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }
}
