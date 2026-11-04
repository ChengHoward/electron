declare namespace Electron {
  interface MouseEvent {
    target?: AgentTarget;
    type: string;
    x: number;
    y: number;
    modifiers?: number;
    button?: string;
    buttons?: number;
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    timestamp?: number;
    pointerType?: string;
    force?: number;
    tangentialPressure?: number;
    tiltX?: number;
    tiltY?: number;
    twist?: number;
  }
  interface KeyEvent {
    target?: AgentTarget;
  }
  interface TouchEvent {
    target?: AgentTarget;
    type: string;
    touchPoints: (AutomationTouchPoint & Point)[];
    modifiers?: number;
    timestamp?: number;
  }
  interface AgentTarget {
    webContentsId: number;
    processId: number;
    routingId: number;
    documentId: number;
    backendNodeId: number;
  }
  interface AgentDomElementInfo extends DomElementInfo {
    target: AgentTarget;
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
  interface VirtualCursorImageOptions {
    hotspot?: Point;
  }
  interface AutomationVirtualCursorOptions {
    enabled?: boolean;
    image?: NativeImage | null;
    hotspot?: Point;
    frameRate?: number;
  }
  interface AutomationOptions {
    isolateInput?: boolean;
    blockRealPointer?: boolean;
    blockRealKeyboard?: boolean;
    keepRendering?: boolean;
    virtualCursor?: AutomationVirtualCursorOptions;
  }
  interface AutomationState {
    isolateInput: boolean;
    blockRealPointer: boolean;
    blockRealKeyboard: boolean;
    keepRendering: boolean;
    virtualCursor: {
      enabled: boolean;
      frameRate: number;
      hotspot: Point;
      customImage: boolean;
    };
    [key: string]: unknown;
  }
  type AutomationMouseEvent = Omit<MouseEvent, 'x' | 'y' | 'target'> &
    ({ target?: never; position: Point; offset?: never } | { target: AgentTarget; offset?: Point; position?: never });
  interface AutomationTouchPoint {
    id?: number;
    radiusX?: number;
    radiusY?: number;
    rotationAngle?: number;
    force?: number;
    tangentialPressure?: number;
    tiltX?: number;
    tiltY?: number;
    twist?: number;
  }
  type AutomationViewportTouchPoint = AutomationTouchPoint & { position: Point; offset?: never };
  type AutomationTargetTouchPoint = AutomationTouchPoint & { offset: Point; position?: never };
  type AutomationTouchEvent = Omit<TouchEvent, 'target' | 'touchPoints'> &
    (
      | { target?: never; touchPoints: AutomationViewportTouchPoint[] }
      | { target: AgentTarget; touchPoints: AutomationTargetTouchPoint[] }
    );
  type ClickElementOptions = ClickSelectorOptions &
    ({ selector: string; target?: never } | { target: AgentTarget; selector?: never });
  type InputSequenceMouseStep = AutomationMouseEvent & {
    kind: 'mouse';
    atMs: number;
    timestamp?: never;
  };
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
    setAutomationOptions(options: AutomationOptions): Promise<void>;
    getAutomationState(): AutomationState;
    resetAutomationOptions(): Promise<void>;
    setVirtualCursorImage(image: NativeImage | null, options?: VirtualCursorImageOptions): void;
    setVirtualCursorFrameRate(fps: number): void;
    dispatchInputSequence(
      steps: (InputSequenceMouseStep | InputSequenceKeyStep)[],
      options?: InputSequenceOptions
    ): Promise<InputSequenceResult>;
    getAgentSnapshot(options?: AgentSnapshotOptions): Promise<AgentSnapshot>;
    querySelectorAcrossDocuments(
      selector: string,
      options?: QuerySelectorDeepOptions
    ): Promise<AgentDomElementInfo | null>;
    findAgentElements(query: AgentFindQuery, options?: AgentSnapshotOptions): Promise<AgentSnapshot>;
    dispatchMouseEvent(event: AutomationMouseEvent): Promise<AgentDispatchResult>;
    dispatchKeyEvent(event: KeyEvent): Promise<AgentDispatchResult>;
    dispatchTouchEvent(event: AutomationTouchEvent): Promise<AgentDispatchResult>;
    clickElement(options: ClickElementOptions): Promise<AgentDispatchResult>;
  }

  namespace Common {
    interface AutomationOptions extends Electron.AutomationOptions {}
    interface AutomationState extends Electron.AutomationState {}
    interface AutomationVirtualCursorOptions extends Electron.AutomationVirtualCursorOptions {}
    type AutomationMouseEvent = Electron.AutomationMouseEvent;
    type AutomationTouchEvent = Electron.AutomationTouchEvent;
    type ClickElementOptions = Electron.ClickElementOptions;
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    type InputSequenceMouseStep = Electron.InputSequenceMouseStep;
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentDomElementInfo extends Electron.AgentDomElementInfo {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }

  namespace Main {
    interface AutomationOptions extends Electron.AutomationOptions {}
    interface AutomationState extends Electron.AutomationState {}
    interface AutomationVirtualCursorOptions extends Electron.AutomationVirtualCursorOptions {}
    type AutomationMouseEvent = Electron.AutomationMouseEvent;
    type AutomationTouchEvent = Electron.AutomationTouchEvent;
    type ClickElementOptions = Electron.ClickElementOptions;
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    type InputSequenceMouseStep = Electron.InputSequenceMouseStep;
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentDomElementInfo extends Electron.AgentDomElementInfo {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }

  namespace CrossProcessExports {
    interface AutomationOptions extends Electron.AutomationOptions {}
    interface AutomationState extends Electron.AutomationState {}
    interface AutomationVirtualCursorOptions extends Electron.AutomationVirtualCursorOptions {}
    type AutomationMouseEvent = Electron.AutomationMouseEvent;
    type AutomationTouchEvent = Electron.AutomationTouchEvent;
    type ClickElementOptions = Electron.ClickElementOptions;
    interface VirtualCursorImageOptions extends Electron.VirtualCursorImageOptions {}
    type InputSequenceMouseStep = Electron.InputSequenceMouseStep;
    interface InputSequenceKeyStep extends Electron.InputSequenceKeyStep {}
    interface InputSequenceOptions extends Electron.InputSequenceOptions {}
    interface InputSequenceResult extends Electron.InputSequenceResult {}
    interface AgentTarget extends Electron.AgentTarget {}
    interface AgentDomElementInfo extends Electron.AgentDomElementInfo {}
    interface AgentElement extends Electron.AgentElement {}
    interface AgentSnapshotOptions extends Electron.AgentSnapshotOptions {}
    interface AgentFrameCoverage extends Electron.AgentFrameCoverage {}
    interface AgentSnapshot extends Electron.AgentSnapshot {}
    interface AgentFindQuery extends Electron.AgentFindQuery {}
    interface AgentDispatchResult extends Electron.AgentDispatchResult {}
  }
}
