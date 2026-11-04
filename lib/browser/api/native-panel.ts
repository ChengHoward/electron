import { app, BaseWindow, nativeTheme, webContents } from 'electron/main';

type NativePanelBackend = Electron.NativePanel & { isDestroyed(): boolean };
const { NativePanel: NativePanelBinding } = process._linkedBinding('electron_browser_native_panel') as {
  NativePanel: { new (options: Electron.NativePanelConstructorOptions): NativePanelBackend; isSupported(): boolean };
};

export type NativePanelContent = Electron.NativePanelContent;

type RecordValue = Record<string, any>;
const types = new Set([
  'row',
  'item',
  'iconButton',
  'column',
  'text',
  'icon',
  'button',
  'toggle',
  'input',
  'option',
  'list',
  'separator',
  'progress'
]);
const placements = new Set(['auto', 'bottom-start', 'bottom-end', 'top-start', 'top-end']);
const modes = new Set(['system', 'light', 'dark']);
const common = ['type', 'id', 'disabled', 'visible', 'width', 'height', 'maxWidth', 'flex', 'tooltip', 'style'];
const fields: Record<string, string[]> = {
  row: ['children', 'gap', 'padding'],
  item: ['children', 'gap', 'padding', 'selected', 'accessibleName'],
  iconButton: ['image', 'accessibleName'],
  column: ['children', 'gap', 'padding'],
  list: ['children', 'gap', 'padding'],
  text: ['text', 'muted', 'fontSize', 'singleLine', 'highlights', 'linkRange'],
  icon: ['image'],
  button: ['text', 'variant', 'image'],
  toggle: ['text', 'checked'],
  input: ['value', 'placeholder', 'maxLength'],
  option: ['items', 'value'],
  separator: [],
  progress: ['value']
};

function object(value: unknown, name: string): asserts value is RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function keys(value: RecordValue, allowed: string[], name: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${name}.${key} is not supported`);
  }
}

function number(value: unknown, name: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${name} must be a finite number between ${min} and ${max}`);
  }
}

function string(value: unknown, name: string, max = 65536) {
  if (typeof value !== 'string' || value.length > max) {
    throw new TypeError(`${name} must be a string of at most ${max} characters`);
  }
}

function boolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
}

function style(value: unknown): RecordValue {
  object(value, 'style');
  const colors = [
    'background',
    'hoverBackground',
    'pressedBackground',
    'selectedBackground',
    'disabledBackground',
    'color',
    'borderColor'
  ];
  const sizes = ['radius', 'borderWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  keys(value, [...colors, ...sizes, 'fontWeight', 'align', 'borderless'], 'style');
  for (const key of colors) {
    if (key in value && (typeof value[key] !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value[key]))) {
      throw new TypeError(`style.${key} must be #RRGGBB or #AARRGGBB`);
    }
  }
  for (const key of sizes) if (key in value) number(value[key], `style.${key}`, 0, 1000);
  if ('fontWeight' in value && !['normal', 'medium', 'bold'].includes(value.fontWeight)) {
    throw new TypeError('Invalid style.fontWeight');
  }
  if ('align' in value && !['start', 'center', 'end'].includes(value.align)) throw new TypeError('Invalid style.align');
  if ('borderless' in value) boolean(value.borderless, 'style.borderless');
  return { ...value };
}

export function validateNativePanelAnchor(value: unknown): Electron.Rectangle {
  object(value, 'anchorBounds');
  keys(value, ['x', 'y', 'width', 'height'], 'anchorBounds');
  number(value.x, 'anchorBounds.x', -1000000, 1000000);
  number(value.y, 'anchorBounds.y', -1000000, 1000000);
  number(value.width, 'anchorBounds.width', 0, 100000);
  number(value.height, 'anchorBounds.height', 0, 100000);
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function content(value: unknown): RecordValue {
  const ids = new Set<string>();
  let count = 0;
  function visit(node: unknown, depth: number): RecordValue {
    object(node, 'content');
    if (depth > 32 || ++count > 2000) throw new RangeError('NativePanel content exceeds the depth or node limit');
    if (!types.has(node.type)) throw new TypeError('Unsupported NativePanel control type');
    keys(node, [...common, ...fields[node.type]], `content(${node.type})`);
    string(node.id, 'content.id', 256);
    if (!node.id || ids.has(node.id)) throw new TypeError('NativePanel controls require unique, nonempty ids');
    ids.add(node.id);
    const result = { ...node };
    for (const key of ['disabled', 'visible', 'muted', 'selected', 'singleLine']) {
      if (key in node) boolean(node[key], key);
    }
    if ('style' in node) result.style = style(node.style);
    if ('accessibleName' in node) string(node.accessibleName, 'accessibleName');
    if (node.type === 'iconButton' && !node.accessibleName) throw new TypeError('iconButton requires accessibleName');
    if ('variant' in node && !['default', 'plain', 'outlined'].includes(node.variant)) {
      throw new TypeError('Invalid button.variant');
    }
    for (const key of ['width', 'height', 'maxWidth', 'gap', 'padding']) {
      if (key in node) number(node[key], key, 0, 100000);
    }
    if ('fontSize' in node) number(node.fontSize, 'fontSize', 6, 96);
    if ('flex' in node) number(node.flex, 'flex', 0, 1000);
    if ('tooltip' in node) string(node.tooltip, 'tooltip');
    if (['row', 'column', 'list', 'item'].includes(node.type)) {
      if (!Array.isArray(node.children)) throw new TypeError('Container children must be an array');
      result.children = node.children.map((child) => visit(child, depth + 1));
    }
    if (['text', 'button', 'toggle'].includes(node.type)) string(node.text, 'text');
    if ('highlights' in node) {
      if (!Array.isArray(node.highlights) || node.highlights.length > 256) {
        throw new TypeError('Invalid text.highlights');
      }
      result.highlights = node.highlights.map((range: unknown) => {
        object(range, 'highlight');
        keys(range, ['start', 'end'], 'highlight');
        number(range.start, 'highlight.start', 0, node.text.length);
        number(range.end, 'highlight.end', range.start, node.text.length);
        if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
          throw new TypeError('Highlight offsets must be integers');
        }
        return { ...range };
      });
    }
    if ('linkRange' in node) {
      object(node.linkRange, 'linkRange');
      keys(node.linkRange, ['start', 'end'], 'linkRange');
      number(node.linkRange.start, 'linkRange.start', 0, node.text.length);
      number(node.linkRange.end, 'linkRange.end', node.linkRange.start + 1, node.text.length);
      if (
        !Number.isInteger(node.linkRange.start) ||
        !Number.isInteger(node.linkRange.end) ||
        node.singleLine ||
        'highlights' in node
      ) {
        throw new TypeError('linkRange requires integer UTF-16 offsets on multiline text without highlights');
      }
      result.linkRange = { ...node.linkRange };
    }
    if (node.type === 'toggle') boolean(node.checked, 'checked');
    if (node.type === 'input') {
      if ('value' in node) string(node.value, 'value');
      if ('placeholder' in node) string(node.placeholder, 'placeholder');
      if ('maxLength' in node) {
        number(node.maxLength, 'maxLength', 0, 65536);
        if (!Number.isInteger(node.maxLength)) throw new TypeError('maxLength must be an integer');
      }
    }
    if (node.type === 'option') {
      if (!Array.isArray(node.items) || node.items.length > 2000) {
        throw new TypeError('option.items must be an array with at most 2000 entries');
      }
      const values = new Set<string>();
      const itemIds = new Set<string>();
      result.items = node.items.map((item: unknown) => {
        object(item, 'option item');
        keys(item, ['id', 'label', 'value', 'disabled'], 'option item');
        string(item.id, 'option item id', 256);
        string(item.label, 'option label');
        if ('value' in item) string(item.value, 'option value');
        if ('disabled' in item) boolean(item.disabled, 'option disabled');
        const value = item.value ?? item.id;
        if (!item.id || itemIds.has(item.id) || values.has(value)) {
          throw new TypeError('Option ids and values must be unique');
        }
        itemIds.add(item.id);
        values.add(value);
        return { ...item, value };
      });
      if ('value' in node) {
        string(node.value, 'option value');
        if (!values.has(node.value)) throw new TypeError('Selected option value must exist in items');
      }
    }
    if (node.type === 'progress') {
      if (node.value !== -1) number(node.value, 'progress value', 0, 1);
    }
    if (node.type === 'icon' || node.type === 'iconButton' || 'image' in node) {
      if (
        !node.image ||
        typeof node.image.toPNG !== 'function' ||
        typeof node.image.isEmpty !== 'function' ||
        node.image.isEmpty()
      ) {
        throw new TypeError('icon.image must be a nonempty NativeImage');
      }
    }
    return result;
  }
  return visit(value, 0);
}

function theme(value: unknown): RecordValue {
  const result = typeof value === 'string' ? { mode: value } : value;
  object(result, 'theme');
  keys(result, ['mode', 'background', 'text', 'muted', 'accent', 'border', 'fontFamily', 'fontSize'], 'theme');
  if ('mode' in result && !modes.has(result.mode)) throw new TypeError('theme.mode must be system, light, or dark');
  for (const key of ['background', 'text', 'muted', 'accent', 'border']) {
    if (key in result && (typeof result[key] !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(result[key]))) {
      throw new TypeError(`theme.${key} must be #RRGGBB or #AARRGGBB`);
    }
  }
  if ('fontFamily' in result) string(result.fontFamily, 'fontFamily', 256);
  if ('fontSize' in result) number(result.fontSize, 'fontSize', 6, 96);
  return { mode: 'system', ...result };
}

function patch(value: unknown): RecordValue {
  object(value, 'patch');
  keys(value, ['content', 'anchorBounds', 'theme', 'radius', 'shadow', 'contentInset'], 'patch');
  const result: RecordValue = { ...value };
  if ('content' in value) result.content = content(value.content);
  if ('anchorBounds' in value) result.anchorBounds = validateNativePanelAnchor(value.anchorBounds);
  if ('theme' in value) result.theme = theme(value.theme);
  if ('radius' in value) number(value.radius, 'radius', 0, 1000);
  if ('shadow' in value) boolean(value.shadow, 'shadow');
  if ('contentInset' in value) {
    number(value.contentInset, 'contentInset', 0, 64);
    if (!Number.isInteger(value.contentInset)) throw new TypeError('contentInset must be an integer');
  }
  return result;
}

function options(value: unknown): RecordValue {
  if (!app.isReady()) throw new Error('NativePanel cannot be created before app is ready');
  object(value, 'options');
  keys(
    value,
    [
      'parent',
      'sourceWebContents',
      'content',
      'theme',
      'radius',
      'contentInset',
      'shadow',
      'focusMode',
      'dismissOnOutsideClick',
      'dismissOnEscape'
    ],
    'options'
  );
  if (!(value.parent instanceof BaseWindow) || value.parent.isDestroyed()) {
    throw new TypeError('parent must be a live BaseWindow or BrowserWindow');
  }
  if (
    'sourceWebContents' in value &&
    (!value.sourceWebContents ||
      !webContents.getAllWebContents().includes(value.sourceWebContents) ||
      value.sourceWebContents.isDestroyed())
  ) {
    throw new TypeError('sourceWebContents must be a live WebContents');
  }
  if (value.sourceWebContents && value.sourceWebContents._getOwnerWindowId() !== value.parent.id) {
    throw new Error('sourceWebContents must belong to parent');
  }
  if ('focusMode' in value && !['none', 'menu', 'input'].includes(value.focusMode)) {
    throw new TypeError('focusMode must be none, menu, or input');
  }
  for (const key of ['dismissOnOutsideClick', 'dismissOnEscape']) if (key in value) boolean(value[key], key);
  return {
    ...value,
    content: content(value.content),
    theme: theme(value.theme ?? 'system'),
    radius: value.radius ?? 12,
    contentInset: value.contentInset ?? 12,
    shadow: value.shadow ?? true,
    focusMode: value.focusMode ?? 'menu',
    dismissOnOutsideClick: value.dismissOnOutsideClick ?? true,
    dismissOnEscape: value.dismissOnEscape ?? true,
    ...patch(
      Object.fromEntries(
        ['radius', 'shadow', 'contentInset'].filter((key) => key in value).map((key) => [key, value[key]])
      )
    )
  };
}

// NativePanelBinding owns Views widgets. This wrapper validates complete patches
// before any native mutation and scopes page-bound instances to their document.
export class NativePanel extends NativePanelBinding {
  #parent: Electron.BaseWindow;
  #source?: Electron.WebContents;
  #listeners: Array<[NodeJS.EventEmitter, string, (...args: any[]) => void]> = [];
  #theme: RecordValue;

  constructor(value: Electron.NativePanelConstructorOptions) {
    const validated = options(value);
    super(validated as Electron.NativePanelConstructorOptions);
    this.#parent = validated.parent;
    this.#source = validated.sourceWebContents;
    this.#theme = validated.theme;
    const listen = (emitter: NodeJS.EventEmitter, event: string, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
      this.#listeners.push([emitter, event, handler]);
    };
    const invalidate = () => this.destroy();
    listen(this.#parent, 'closed', invalidate);
    if (this.#source) {
      listen(this.#source, 'destroyed', invalidate);
      listen(
        this.#source,
        'did-start-navigation',
        (_event: any, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
          if (isMainFrame) invalidate();
        }
      );
      listen(this.#source, 'render-process-gone', invalidate);
      listen(this.#source, '-owner-window-changed', invalidate);
    }
    listen(nativeTheme, 'updated', () => {
      if (this.#theme.mode === 'system' && !this.isDestroyed()) super.update({ theme: this.#theme });
    });
    this.once('closed', () => {
      for (const [emitter, event, handler] of this.#listeners) emitter.removeListener(event, handler);
      this.#listeners = [];
      this.#source = undefined;
    });
  }

  static isSupported(): boolean {
    return process.platform === 'win32' && process.arch === 'x64' && NativePanelBinding.isSupported();
  }

  show(value: Electron.NativePanelShowOptions): void {
    this.#checkAlive();
    object(value, 'show options');
    keys(value, ['anchorBounds', 'placement'], 'show options');
    if ('placement' in value && (typeof value.placement !== 'string' || !placements.has(value.placement))) {
      throw new TypeError('Invalid NativePanel placement');
    }
    super.show({ anchorBounds: validateNativePanelAnchor(value.anchorBounds), placement: value.placement ?? 'auto' });
  }

  update(value: Electron.NativePanelUpdateOptions): void {
    this.#checkAlive();
    const validated = patch(value);
    super.update(validated);
    if (validated.theme) this.#theme = validated.theme;
  }

  hide(): void {
    this.#checkAlive();
    super.hide();
  }

  destroy(): void {
    if (!this.isDestroyed()) super.destroy();
  }

  #checkAlive() {
    if (this.isDestroyed()) throw new Error('NativePanel has been destroyed');
    if (
      this.#parent.isDestroyed() ||
      (this.#source && (this.#source.isDestroyed() || this.#source._getOwnerWindowId() !== this.#parent.id))
    ) {
      this.destroy();
      throw new Error('NativePanel no longer has a valid host');
    }
  }
}

export default NativePanel;
