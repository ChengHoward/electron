import type {
  InputSequenceKeyStep,
  InputSequenceMouseStep,
  InputSequenceOptions,
  InputSequenceResult,
  NativeImage,
  VirtualCursorImageOptions,
  AutomationOptions,
  WebContents
} from 'electron';
import type { InputSequenceOptions as MainSequenceOptions } from 'electron/main';

declare const contents: WebContents;
declare const image: NativeImage;
const cursor: AutomationOptions = {
  isolateInput: true,
  keepRendering: true,
  blockRealPointer: true,
  blockRealKeyboard: false,
  virtualCursor: { enabled: true }
};
const imageOptions: VirtualCursorImageOptions = { hotspot: { x: 1, y: 2 } };
const mouse: InputSequenceMouseStep = { kind: 'mouse', atMs: 0, type: 'mouseMoved', position: { x: 1.5, y: 2.5 } };
const key: InputSequenceKeyStep = { kind: 'key', atMs: 1, type: 'char', text: 'A' };
const options: InputSequenceOptions & MainSequenceOptions = {
  signal: new AbortController().signal,
  focusTimeoutMs: 100
};
const configured: Promise<void> = contents.setAutomationOptions(cursor);
contents.setVirtualCursorImage(image, imageOptions);
contents.setVirtualCursorFrameRate(30);
const sequence: Promise<InputSequenceResult> = contents.dispatchInputSequence([mouse, key], options);
// @ts-expect-error The sequence owns event timestamps.
const invalid: InputSequenceMouseStep = { ...mouse, timestamp: 1 };
export { configured, sequence, invalid };

const state = contents.getAutomationState();
const reset: Promise<void> = contents.resetAutomationOptions();
// @ts-expect-error Viewport coordinates require an explicit position.
const oldCoordinates: InputSequenceMouseStep = { kind: 'mouse', atMs: 0, type: 'mouseMoved', x: 1, y: 2 };
// @ts-expect-error Target and selector are mutually exclusive.
contents.clickElement({
  selector: 'button',
  target: { webContentsId: 1, processId: 2, routingId: 3, documentId: 4, backendNodeId: 5 }
});
export { state, reset, oldCoordinates };

contents.querySelectorAcrossDocuments('iframe >>> input').then((match) => {
  if (match) contents.dispatchKeyEvent({ type: 'char', target: match.target, text: 'A' });
});
