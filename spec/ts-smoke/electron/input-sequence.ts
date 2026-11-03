import type {
  InputSequenceKeyStep,
  InputSequenceMouseStep,
  InputSequenceOptions,
  InputSequenceResult,
  NativeImage,
  VirtualCursorImageOptions,
  VirtualCursorOptions,
  WebContents
} from 'electron';
import type { InputSequenceOptions as MainSequenceOptions } from 'electron/main';

declare const contents: WebContents;
declare const image: NativeImage;
const cursor: VirtualCursorOptions = { blockRealPointer: true, blockRealKeyboard: false };
const imageOptions: VirtualCursorImageOptions = { hotspot: { x: 1, y: 2 } };
const mouse: InputSequenceMouseStep = { kind: 'mouse', atMs: 0, type: 'mouseMoved', x: 1.5, y: 2.5 };
const key: InputSequenceKeyStep = { kind: 'key', atMs: 1, type: 'char', text: 'A' };
const options: InputSequenceOptions & MainSequenceOptions = {
  signal: new AbortController().signal,
  focusTimeoutMs: 100
};
const configured: Promise<void> = contents.setVirtualCursorEnabled(true, cursor);
contents.setVirtualCursorImage(image, imageOptions);
contents.setVirtualCursorFrameRate(30);
const sequence: Promise<InputSequenceResult> = contents.dispatchInputSequence([mouse, key], options);
// @ts-expect-error The sequence owns event timestamps.
const invalid: InputSequenceMouseStep = { ...mouse, timestamp: 1 };
export { configured, sequence, invalid };
