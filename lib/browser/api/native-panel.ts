import { app, BaseWindow, Menu, nativeTheme, screen, webContents } from 'electron/main';

interface NativePanelBackend extends NodeJS.EventEmitter {
  show(options: Electron.NativePanelShowOptions): void;
  update(options: Electron.NativePanelUpdateOptions): void;
  hide(): void;
  destroy(): void;
  isDestroyed(): boolean;
  _command(command: RecordValue): { ok: boolean };
  _getState(): RecordValue;
}
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
  'textarea',
  'option',
  'list',
  'separator',
  'progress'
]);
const placements = new Set(['auto', 'bottom-start', 'bottom-end', 'top-start', 'top-end']);
const modes = new Set(['system', 'light', 'dark']);
const common = [
  'type',
  'id',
  'disabled',
  'visible',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'flex',
  'tooltip',
  'style',
  'styleName',
  'contextMenu',
  'accessibleName',
  'accessibleDescription',
  'role',
  'expanded',
  'busy'
];
const fields: Record<string, string[]> = {
  row: ['children', 'gap', 'padding', 'wrap', 'justify'],
  item: ['children', 'gap', 'padding', 'selected', 'justify'],
  iconButton: ['image', 'hoverOnly', 'iconSize'],
  column: ['children', 'gap', 'padding', 'justify'],
  list: ['children', 'gap', 'padding', 'scrollbarPlacement', 'virtual'],
  text: ['text', 'muted', 'fontSize', 'singleLine', 'highlights', 'linkRange', 'links', 'selectable', 'maxLines'],
  icon: ['image'],
  button: ['text', 'variant', 'image'],
  toggle: ['text', 'checked'],
  input: ['value', 'placeholder', 'maxLength', 'readOnly', 'password', 'invalid', 'navigationTarget'],
  textarea: [
    'value',
    'placeholder',
    'maxLength',
    'submitOnEnter',
    'scrollbarPlacement',
    'readOnly',
    'invalid',
    'autoGrow'
  ],
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

const states = ['hover', 'pressed', 'selected', 'active', 'focused', 'disabled', 'invalid', 'busy'];
const paintColors = ['background', 'color', 'borderColor', 'linkColor'];
const colorFields = [
  ...paintColors,
  ...states.flatMap((state) => ['Background', 'Color', 'BorderColor'].map((suffix) => state + suffix))
];

function color(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^(?:#(?:[0-9a-f]{6}|[0-9a-f]{8})|\$[a-z][\w.-]*)$/i.test(value)) {
    throw new TypeError(`${name} must be a hex color or $token`);
  }
}

function style(value: unknown): RecordValue {
  object(value, 'style');
  const sizes = ['radius', 'borderWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
  keys(
    value,
    [
      ...colorFields,
      ...sizes,
      ...states,
      'fontFamily',
      'fontSize',
      'fontWeight',
      'align',
      'verticalAlign',
      'lineHeight',
      'textDecoration',
      'borderless'
    ],
    'style'
  );
  const result: RecordValue = { ...value };
  for (const key of colorFields) if (key in value) color(value[key], `style.${key}`);
  for (const key of sizes) if (key in value) number(value[key], `style.${key}`, 0, 1000);
  for (const state of states) {
    if (!(state in value)) continue;
    object(value[state], `style.${state}`);
    keys(value[state], paintColors, `style.${state}`);
    result[state] = { ...value[state] };
    for (const key of Object.keys(value[state])) color(value[state][key], `style.${state}.${key}`);
  }
  if ('fontFamily' in value) string(value.fontFamily, 'style.fontFamily', 256);
  if ('fontSize' in value) number(value.fontSize, 'style.fontSize', 6, 96);
  if ('lineHeight' in value) number(value.lineHeight, 'style.lineHeight', 0, 256);
  if ('fontWeight' in value && !['normal', 'medium', 'bold'].includes(value.fontWeight)) {
    throw new TypeError('Invalid style.fontWeight');
  }
  if ('align' in value && !['start', 'center', 'end', 'stretch'].includes(value.align)) {
    throw new TypeError('Invalid style.align');
  }
  if ('verticalAlign' in value && !['top', 'middle', 'bottom'].includes(value.verticalAlign)) {
    throw new TypeError('Invalid style.verticalAlign');
  }
  if ('textDecoration' in value && !['none', 'line-through', 'underline'].includes(value.textDecoration)) {
    throw new TypeError('Invalid style.textDecoration');
  }
  if ('borderless' in value) boolean(value.borderless, 'style.borderless');
  return result;
}

function compileContent(tree: RecordValue, configuration: RecordValue): RecordValue {
  const dark = configuration.mode === 'dark' || (configuration.mode === 'system' && nativeTheme.shouldUseDarkColors);
  const tokens: RecordValue = {
    background: dark ? '#202020' : '#FFFFFF',
    text: dark ? '#F0F0F0' : '#202020',
    muted: dark ? '#B0B0B0' : '#606060',
    accent: dark ? '#8AB4F8' : '#1967D2',
    border: dark ? '#606060' : '#D0D0D0',
    surface: dark ? '#18FFFFFF' : '#70FFFFFF',
    surfaceHover: dark ? '#12FFFFFF' : '#0C000000',
    surfacePressed: dark ? '#1FFFFFFF' : '#14000000',
    surfaceSelected: dark ? '#24FFFFFF' : '#16000000',
    inputSurface: dark ? '#30000000' : '#88FFFFFF',
    subtleBorder: dark ? '#20FFFFFF' : '#18000000',
    danger: dark ? '#FFB4AB' : '#A4262C',
    ...Object.fromEntries(
      ['background', 'text', 'muted', 'accent', 'border']
        .filter((key) => key in configuration)
        .map((key) => [key, configuration[key]])
    ),
    ...configuration.tokens
  };
  const resolve = (value: unknown, seen = new Set<string>()): unknown => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const key = value.slice(1);
      if (!(key in tokens) || seen.has(key)) throw new TypeError(`Unknown or cyclic style token: ${key}`);
      return resolve(tokens[key], new Set([...seen, key]));
    }
    return value;
  };
  const visit = (node: RecordValue): RecordValue => {
    const { styleName, children, ...result } = node;
    const names = typeof styleName === 'string' ? [styleName] : (styleName ?? []);
    let merged: RecordValue = {};
    for (const name of names) {
      if (!Object.hasOwn(configuration.styles ?? {}, name)) throw new TypeError(`Unknown native style: ${name}`);
      merged = { ...merged, ...configuration.styles[name] };
    }
    merged = { ...merged, ...node.style };
    for (const key of colorFields) if (key in merged) merged[key] = resolve(merged[key]);
    for (const state of states) {
      if (state in merged) {
        merged[state] = Object.fromEntries(Object.entries(merged[state]).map(([key, value]) => [key, resolve(value)]));
      }
    }
    result.style = merged;
    if (children) result.children = children.map(visit);
    return result;
  };
  for (const key of Object.keys(tokens)) resolve('$' + key);
  return visit(tree);
}

function nativeThemeOptions(configuration: RecordValue): RecordValue {
  const { tokens, styles, ...native } = configuration;
  return native;
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
  const lists = new Set<string>();
  let count = 0;
  let mounted = 0;
  function visit(node: unknown, depth: number, virtualRow = false): RecordValue {
    object(node, 'content');
    if (depth > 32 || ++count > 100000 || (!virtualRow && ++mounted > 2000)) {
      throw new RangeError('NativePanel content exceeds the depth or node limit');
    }
    if (!types.has(node.type)) throw new TypeError('Unsupported NativePanel control type');
    keys(node, [...common, ...fields[node.type]], `content(${node.type})`);
    string(node.id, 'content.id', 256);
    if (!node.id || node.id.startsWith('__native_panel_virtual__:') || ids.has(node.id)) {
      throw new TypeError('NativePanel controls require unique, nonempty ids');
    }
    ids.add(node.id);
    if (node.type === 'list') lists.add(node.id);
    const result = { ...node };
    for (const key of [
      'disabled',
      'visible',
      'muted',
      'selected',
      'singleLine',
      'hoverOnly',
      'contextMenu',
      'expanded',
      'busy',
      'readOnly',
      'password',
      'invalid',
      'autoGrow',
      'selectable',
      'wrap'
    ]) {
      if (key in node) boolean(node[key], key);
    }
    if ('style' in node) result.style = style(node.style);
    if ('styleName' in node) {
      const names = typeof node.styleName === 'string' ? [node.styleName] : node.styleName;
      if (!Array.isArray(names) || names.length > 32) throw new TypeError('Invalid styleName');
      for (const name of names) string(name, 'styleName', 256);
      result.styleName = [...names];
    }
    if ('accessibleDescription' in node) string(node.accessibleDescription, 'accessibleDescription');
    if ('role' in node && !['listbox', 'option', 'menu', 'menuitem', 'group', 'status'].includes(node.role)) {
      throw new TypeError('Unsupported accessible role');
    }
    if ('justify' in node && !['start', 'center', 'end'].includes(node.justify)) throw new TypeError('Invalid justify');
    if ('navigationTarget' in node) string(node.navigationTarget, 'navigationTarget', 256);
    if ('maxLines' in node) {
      number(node.maxLines, 'maxLines', 0, 1000);
      if (!Number.isInteger(node.maxLines)) throw new TypeError('maxLines must be an integer');
    }
    if ('iconSize' in node) number(node.iconSize, 'iconSize', 1, 256);
    for (const axis of ['Width', 'Height']) {
      if (node[`max${axis}`] && node[`min${axis}`] > node[`max${axis}`]) {
        throw new TypeError('Minimum size exceeds maximum');
      }
    }
    if (
      virtualRow &&
      !['item', 'row', 'column', 'text', 'icon', 'button', 'iconButton', 'separator'].includes(node.type)
    ) {
      throw new TypeError('Virtual rows support stateless display and action controls');
    }
    if ('scrollbarPlacement' in node) result.scrollbarPlacement = scrollbarPlacement(node.scrollbarPlacement);
    if ('accessibleName' in node) string(node.accessibleName, 'accessibleName');
    if (node.type === 'iconButton' && !node.accessibleName) throw new TypeError('iconButton requires accessibleName');
    if ('variant' in node && !['default', 'plain', 'outlined'].includes(node.variant)) {
      throw new TypeError('Invalid button.variant');
    }
    for (const key of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'gap', 'padding']) {
      if (key in node) number(node[key], key, 0, 100000);
    }
    if ('fontSize' in node) number(node.fontSize, 'fontSize', 6, 96);
    if ('flex' in node) number(node.flex, 'flex', 0, 1000);
    if ('tooltip' in node) string(node.tooltip, 'tooltip');
    if (['row', 'column', 'list', 'item'].includes(node.type)) {
      if (!Array.isArray(node.children)) throw new TypeError('Container children must be an array');
      if ('virtual' in node) {
        object(node.virtual, 'virtual');
        keys(node.virtual, ['itemHeight', 'overscan'], 'virtual');
        number(node.virtual.itemHeight, 'virtual.itemHeight', 1, 1000);
        if ('overscan' in node.virtual) number(node.virtual.overscan, 'virtual.overscan', 0, 32);
        if (
          !Number.isInteger(node.virtual.itemHeight) ||
          ('overscan' in node.virtual && !Number.isInteger(node.virtual.overscan))
        ) {
          throw new TypeError('Virtual dimensions must be integers');
        }
        if (node.children.length > 50000 || node.children.some((child: RecordValue) => child.type !== 'item')) {
          throw new TypeError('Virtual list requires at most 50000 item rows');
        }
        if (node.gap || node.padding || node.style?.paddingTop || node.style?.paddingBottom) {
          throw new TypeError('Virtual list spacing belongs inside each fixed-height row');
        }
        result.virtual = { itemHeight: node.virtual.itemHeight, overscan: node.virtual.overscan ?? 3 };
      }
      const rowCosts: number[] = [];
      result.children = node.children.map((child) => {
        const before = count;
        const result = visit(child, depth + 1, virtualRow || 'virtual' in node);
        rowCosts.push(count - before);
        return result;
      });
      if ('virtual' in node) {
        const window = Math.min(
          rowCosts.length,
          Math.ceil((node.height ?? 240) / result.virtual.itemHeight) + 2 * result.virtual.overscan + 1
        );
        let cost = rowCosts.slice(0, window).reduce((sum, value) => sum + value, 0);
        let maximum = cost;
        for (let index = window; index < rowCosts.length; index++) {
          cost += rowCosts[index] - rowCosts[index - window];
          maximum = Math.max(maximum, cost);
        }
        mounted += maximum + 2;
        if (mounted > 2000) throw new RangeError('Virtual viewport exceeds the mounted node limit');
      }
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
    if ('links' in node) {
      if (
        !Array.isArray(node.links) ||
        node.links.length > 256 ||
        'linkRange' in node ||
        node.singleLine ||
        'highlights' in node ||
        node.selectable
      ) {
        throw new TypeError('Invalid text.links combination');
      }
      const linkIds = new Set<string>();
      let end = 0;
      result.links = node.links.map((link: unknown) => {
        object(link, 'link');
        keys(link, ['id', 'start', 'end'], 'link');
        string(link.id, 'link.id', 256);
        number(link.start, 'link.start', end, node.text.length);
        number(link.end, 'link.end', link.start + 1, node.text.length);
        if (!link.id || linkIds.has(link.id) || !Number.isInteger(link.start) || !Number.isInteger(link.end)) {
          throw new TypeError('Links require unique IDs and sorted nonoverlapping UTF-16 ranges');
        }
        linkIds.add(link.id);
        end = link.end;
        return { ...link };
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
        'highlights' in node ||
        node.selectable
      ) {
        throw new TypeError('linkRange requires integer UTF-16 offsets on multiline text without highlights');
      }
      result.linkRange = { ...node.linkRange };
    }
    if (node.type === 'toggle') boolean(node.checked, 'checked');
    if (node.type === 'input' || node.type === 'textarea') {
      if ('value' in node) string(node.value, 'value');
      if ('placeholder' in node) string(node.placeholder, 'placeholder');
      if ('submitOnEnter' in node) boolean(node.submitOnEnter, 'submitOnEnter');
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
  const result = visit(value, 0);
  const verify = (node: RecordValue) => {
    if (node.navigationTarget && !lists.has(node.navigationTarget)) {
      throw new TypeError('navigationTarget must identify a live list');
    }
    for (const child of node.children ?? []) verify(child);
  };
  verify(result);
  return result;
}

function theme(value: unknown): RecordValue {
  const result = typeof value === 'string' ? { mode: value } : value;
  object(result, 'theme');
  keys(
    result,
    [
      'mode',
      'background',
      'materialTint',
      'text',
      'muted',
      'accent',
      'border',
      'fontFamily',
      'fontSize',
      'tokens',
      'styles'
    ],
    'theme'
  );
  if ('mode' in result && !modes.has(result.mode)) throw new TypeError('theme.mode must be system, light, or dark');
  for (const key of ['background', 'materialTint', 'text', 'muted', 'accent', 'border']) {
    if (key in result && (typeof result[key] !== 'string' || !/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(result[key]))) {
      throw new TypeError(`theme.${key} must be #RRGGBB or #AARRGGBB`);
    }
  }
  if ('fontFamily' in result) string(result.fontFamily, 'fontFamily', 256);
  if ('fontSize' in result) number(result.fontSize, 'fontSize', 6, 96);
  const output: RecordValue = { mode: 'system', ...result };
  if ('tokens' in result) {
    object(result.tokens, 'theme.tokens');
    if (Object.keys(result.tokens).length > 256) throw new RangeError('Too many theme tokens');
    output.tokens = {};
    for (const [key, value] of Object.entries(result.tokens)) {
      if (!/^[a-z][\w.-]*$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new TypeError('Invalid theme token name');
      }
      color(value, `theme.tokens.${key}`);
      output.tokens[key] = value;
    }
  }
  if ('styles' in result) {
    object(result.styles, 'theme.styles');
    if (Object.keys(result.styles).length > 256) throw new RangeError('Too many shared styles');
    output.styles = {};
    for (const [key, value] of Object.entries(result.styles)) {
      if (!key || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new TypeError('Invalid style name');
      }
      output.styles[key] = style(value);
    }
  }
  return output;
}

function backgroundMaterial(value: unknown): string {
  if (typeof value !== 'string' || !['none', 'acrylic'].includes(value)) {
    throw new TypeError('backgroundMaterial must be none or acrylic');
  }
  return value;
}

function scrollbarPlacement(value: unknown): string {
  if (typeof value !== 'string' || !['overlay', 'gutter'].includes(value)) {
    throw new TypeError('scrollbarPlacement must be overlay or gutter');
  }
  return value;
}

function patch(value: unknown): RecordValue {
  object(value, 'patch');
  keys(
    value,
    [
      'content',
      'revision',
      'expectedRevision',
      'anchorBounds',
      'theme',
      'radius',
      'shadow',
      'contentInset',
      'backgroundMaterial',
      'scrollbarPlacement'
    ],
    'patch'
  );
  const result: RecordValue = { ...value };
  for (const key of ['revision', 'expectedRevision']) {
    if (key in value) {
      number(value[key], key, 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isInteger(value[key])) throw new TypeError(`${key} must be an integer`);
    }
  }
  if ('content' in value) result.content = content(value.content);
  if ('anchorBounds' in value) result.anchorBounds = validateNativePanelAnchor(value.anchorBounds);
  if ('theme' in value) result.theme = theme(value.theme);
  if ('backgroundMaterial' in value) result.backgroundMaterial = backgroundMaterial(value.backgroundMaterial);
  if ('scrollbarPlacement' in value) result.scrollbarPlacement = scrollbarPlacement(value.scrollbarPlacement);
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
      'parentPanel',
      'sourceWebContents',
      'content',
      'theme',
      'backgroundMaterial',
      'scrollbarPlacement',
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
    backgroundMaterial: value.backgroundMaterial ?? 'none',
    scrollbarPlacement: value.scrollbarPlacement ?? 'gutter',
    radius: value.radius ?? 12,
    contentInset: value.contentInset ?? 12,
    shadow: value.shadow ?? true,
    focusMode: value.focusMode ?? 'menu',
    dismissOnOutsideClick: value.dismissOnOutsideClick ?? true,
    dismissOnEscape: value.dismissOnEscape ?? true,
    ...patch(
      Object.fromEntries(
        ['radius', 'shadow', 'contentInset', 'backgroundMaterial', 'scrollbarPlacement']
          .filter((key) => key in value)
          .map((key) => [key, value[key]])
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
  #content: RecordValue;
  #revision = 0;
  #parentPanel?: NativePanel;
  #children = new Set<NativePanel>();
  #menu?: { menu: Electron.Menu; id?: string };

  constructor(value: Electron.NativePanelConstructorOptions) {
    const validated = options(value);
    const parentPanel = validated.parentPanel as NativePanel | undefined;
    if (
      parentPanel &&
      (!(parentPanel instanceof NativePanel) || parentPanel.isDestroyed() || parentPanel.#parent !== validated.parent)
    ) {
      throw new TypeError('parentPanel must be a live panel with the same parent window');
    }
    const { parentPanel: unused, ...native } = validated;
    super({
      ...native,
      theme: nativeThemeOptions(validated.theme),
      content: compileContent(validated.content, validated.theme)
    } as Electron.NativePanelConstructorOptions);
    this.#parent = validated.parent;
    this.#source = validated.sourceWebContents;
    this.#theme = validated.theme;
    this.#content = validated.content;
    this.#parentPanel = parentPanel;
    if (parentPanel) parentPanel.#children.add(this);
    this.#syncRelated();
    const listen = (emitter: NodeJS.EventEmitter, event: string, handler: (...args: any[]) => void) => {
      emitter.on(event, handler);
      this.#listeners.push([emitter, event, handler]);
    };
    const invalidate = () => this.destroy();
    listen(this.#parent, 'closed', invalidate);
    if (this.#source) {
      listen(this.#source, 'destroyed', invalidate);
      listen(this.#source, 'did-start-navigation', (_event: any, _url: string, _inPlace: boolean, main: boolean) => {
        if (main) invalidate();
      });
      listen(this.#source, 'render-process-gone', invalidate);
      listen(this.#source, '-owner-window-changed', invalidate);
    }
    listen(nativeTheme, 'updated', () => {
      if (this.#theme.mode === 'system' && !this.isDestroyed()) this.update({ theme: this.#theme });
    });
    this.prependListener('action', (action: RecordValue) => {
      action.revision = this.#revision;
      if (action.type === 'context-menu') this.emit('context-menu', action);
    });
    this.on('_close-menu' as any, () => this.#closeMenu());
    this.on('dismissed', () => {
      this.#closeMenu();
      for (const child of this.#children) if (!child.isDestroyed()) child.hide();
    });
    this.once('closed', () => {
      this.#closeMenu();
      for (const child of [...this.#children]) child.destroy();
      const owner = this.#parentPanel;
      if (owner) owner.#children.delete(this);
      this.#parentPanel = undefined;
      if (owner && !owner.isDestroyed()) owner.#syncRelated();
      for (const [emitter, event, handler] of this.#listeners) emitter.removeListener(event, handler);
      this.#listeners = [];
      this.#source = undefined;
    });
  }

  static isSupported(): boolean {
    return process.platform === 'win32' && process.arch === 'x64' && NativePanelBinding.isSupported();
  }

  static getCapabilities(): RecordValue {
    const supported = this.isSupported();
    return {
      supported,
      apiVersion: 2,
      backend: 'views',
      createsWebContents: false,
      features: supported
        ? [
            'descendant-hover',
            'context-menu',
            'owned-popups',
            'active-item',
            'node-transactions',
            'revision-guards',
            'wrap-layout',
            'virtual-list',
            'shared-styles',
            'state-styles',
            'selectable-text',
            'multiple-links',
            'native-editing',
            'accessibility',
            'diagnostics'
          ]
        : [],
      limits: { mountedNodes: 2000, dataNodes: 100000, virtualRows: 50000, depth: 32 }
    };
  }

  static createElement(
    type: string,
    properties: RecordValue,
    ...children: Electron.NativePanelContent[]
  ): Electron.NativePanelContent {
    const node = {
      ...properties,
      type,
      ...(['row', 'column', 'item', 'list'].includes(type) ? { children: children.flat() } : {})
    };
    return content(node) as Electron.NativePanelContent;
  }

  get revision(): number {
    return this.#revision;
  }

  show(value: Electron.NativePanelShowOptions): void {
    this.#checkAlive();
    if (this.#parentPanel && !this.#parentPanel.getDiagnostics().visible) {
      throw new Error('Show the parent panel first');
    }
    object(value, 'show options');
    keys(value, ['anchorBounds', 'placement'], 'show options');
    if ('placement' in value && (typeof value.placement !== 'string' || !placements.has(value.placement))) {
      throw new TypeError('Invalid NativePanel placement');
    }
    super.show({ anchorBounds: validateNativePanelAnchor(value.anchorBounds), placement: value.placement ?? 'auto' });
    this.#syncRelated();
  }

  update(value: Electron.NativePanelUpdateOptions): boolean {
    this.#checkAlive();
    const validated = patch(value);
    if ('expectedRevision' in validated && validated.expectedRevision !== this.#revision) return false;
    if ('revision' in validated && validated.revision <= this.#revision) return false;
    if ('revision' in validated && !validated.content) throw new TypeError('revision requires a content update');
    if (validated.content && !Number.isSafeInteger(validated.revision ?? this.#revision + 1)) {
      throw new RangeError('Content revision exceeds the safe integer limit');
    }
    const nextTheme = validated.theme ?? this.#theme;
    const nextContent = validated.content ?? this.#content;
    const { revision, expectedRevision, ...native } = validated;
    if (validated.content || validated.theme) native.content = compileContent(nextContent, nextTheme);
    if (validated.theme) native.theme = nativeThemeOptions(nextTheme);
    super.update(native);
    this.#theme = nextTheme;
    this.#content = nextContent;
    if (validated.content) this.#revision = revision ?? this.#revision + 1;
    return true;
  }

  applyPatch(operations: RecordValue[], options: RecordValue = {}): boolean {
    this.#checkAlive();
    object(options, 'transaction options');
    keys(options, ['revision', 'expectedRevision'], 'transaction options');
    if (!Array.isArray(operations) || operations.length > 2000) {
      throw new TypeError('operations must be an array with at most 2000 entries');
    }
    const clone = (node: RecordValue, depth = 0): RecordValue => {
      object(node, 'patch node');
      if (depth > 32) throw new RangeError('Patch node exceeds the depth limit');
      if ('children' in node && !Array.isArray(node.children)) throw new TypeError('children must be an array');
      return {
        ...node,
        ...(node.children ? { children: node.children.map((child: RecordValue) => clone(child, depth + 1)) } : {})
      };
    };
    let next = clone(this.#content);
    const locate = (id: string): { node: RecordValue; parent?: RecordValue } => {
      let found: { node: RecordValue; parent?: RecordValue } | undefined;
      const visit = (node: RecordValue, parent?: RecordValue) => {
        if (node.id === id) found = { node, parent };
        for (const child of node.children ?? []) visit(child, node);
      };
      visit(next);
      if (!found) throw new TypeError(`Unknown node: ${id}`);
      return found;
    };
    for (const operation of operations) {
      object(operation, 'operation');
      string(operation.id, 'operation.id', 256);
      const { node, parent } = locate(operation.id);
      if (operation.op === 'set') {
        keys(operation, ['op', 'id', 'properties'], 'set operation');
        object(operation.properties, 'properties');
        if ('id' in operation.properties || 'type' in operation.properties || 'children' in operation.properties) {
          throw new TypeError('set cannot replace identity or children');
        }
        keys(
          operation.properties,
          [...common, ...fields[node.type]].filter((key) => !['type', 'id', 'children'].includes(key)),
          'properties'
        );
        Object.assign(node, operation.properties);
      } else if (operation.op === 'remove') {
        keys(operation, ['op', 'id'], 'remove operation');
        if (!parent) throw new TypeError('Cannot remove the root');
        parent.children.splice(parent.children.indexOf(node), 1);
      } else if (operation.op === 'insert') {
        keys(operation, ['op', 'id', 'index', 'node'], 'insert operation');
        if (!node.children) throw new TypeError('insert requires a container');
        number(operation.index, 'index', 0, node.children.length);
        if (!Number.isInteger(operation.index)) throw new TypeError('index must be an integer');
        node.children.splice(operation.index, 0, clone(operation.node));
      } else if (operation.op === 'replace') {
        keys(operation, ['op', 'id', 'node'], 'replace operation');
        if (parent) parent.children[parent.children.indexOf(node)] = clone(operation.node);
        else next = clone(operation.node);
      } else throw new TypeError('Unsupported node operation');
    }
    return this.update({ content: next, ...options } as Electron.NativePanelUpdateOptions);
  }

  focus(id: string): boolean {
    return this.#nodeCommand('focus', id);
  }
  scrollTo(id: string): boolean {
    return this.#nodeCommand('scroll', id);
  }
  setActiveItem(id: string | null): boolean {
    return this.#nodeCommand('active', id ?? '');
  }
  scrollListTo(id: string, offset: number): boolean {
    this.#checkAlive();
    string(id, 'id', 256);
    number(offset, 'offset', 0, 50000000);
    return super._command({ type: 'scroll-offset', id, offset }).ok;
  }
  announce(text: string, assertive = false): void {
    this.#checkAlive();
    string(text, 'announcement');
    boolean(assertive, 'assertive');
    super._command({ type: 'announce', text, assertive });
  }
  getBounds(id?: string): Electron.Rectangle | null {
    this.#checkAlive();
    if (id !== undefined) string(id, 'id', 256);
    const state = super._getState();
    return id === undefined
      ? state.bounds
      : (state.controls.find((node: RecordValue) => node.id === id)?.bounds ?? null);
  }
  getDiagnostics(): Electron.NativePanelDiagnostics {
    this.#checkAlive();
    return { ...super._getState(), revision: this.#revision } as Electron.NativePanelDiagnostics;
  }

  popupMenu(menu: Electron.Menu, options: RecordValue = {}): void {
    this.#checkAlive();
    if (!(menu instanceof Menu)) throw new TypeError('menu must be an Electron Menu');
    object(options, 'menu options');
    keys(options, ['id', 'x', 'y', 'sourceType'], 'menu options');
    if (options.id !== undefined) string(options.id, 'menu target id', 256);
    if (options.sourceType !== undefined && !['mouse', 'keyboard'].includes(options.sourceType)) {
      throw new TypeError('Invalid menu sourceType');
    }
    if ('x' in options !== 'y' in options) throw new TypeError('Supply both menu x and y');
    for (const key of ['x', 'y']) if (key in options) number(options[key], key, -1000000, 1000000);
    const state = this.getDiagnostics();
    if (!state.visible) throw new Error('Cannot open a menu on a hidden panel');
    const target =
      options.id === undefined
        ? undefined
        : state.controls.find((node: RecordValue) => node.id === options.id && node.visible && node.enabled);
    if (options.id !== undefined && !target) throw new TypeError('Menu target must be visible and enabled');
    this.#closeMenu();
    const record = { menu, id: options.id };
    this.#menu = record;
    const cursor = screen.getCursorScreenPoint();
    const x = options.x ?? (target ? target.bounds.x : cursor.x);
    const y = options.y ?? (target ? target.bounds.y + target.bounds.height : cursor.y);
    const origin = this.#parent.getContentBounds();
    super._command({ type: 'menu', id: options.id, open: true });
    try {
      menu.popup({
        window: this.#parent,
        x: Math.round(x - origin.x),
        y: Math.round(y - origin.y),
        sourceType: options.sourceType,
        callback: () => {
          if (this.#menu !== record) return;
          this.#menu = undefined;
          if (!this.isDestroyed()) super._command({ type: 'menu', open: false });
        }
      });
    } catch (error) {
      this.#closeMenu();
      throw error;
    }
  }

  hide(): void {
    this.#checkAlive();
    this.#closeMenu();
    for (const child of this.#children) if (!child.isDestroyed()) child.hide();
    super.hide();
  }
  destroy(): void {
    if (!this.isDestroyed()) {
      this.#closeMenu();
      super.destroy();
    }
  }
  #nodeCommand(type: string, id: string): boolean {
    this.#checkAlive();
    string(id, 'id', 256);
    return super._command({ type, id }).ok;
  }
  #closeMenu() {
    const record = this.#menu;
    if (!record) return;
    this.#menu = undefined;
    if (!this.#parent.isDestroyed()) record.menu.closePopup(this.#parent);
    if (!this.isDestroyed()) super._command({ type: 'menu', open: false });
  }
  #syncRelated() {
    let root: NativePanel = this;
    while (root.#parentPanel) root = root.#parentPanel;
    const panels: NativePanel[] = [];
    const visit = (panel: NativePanel) => {
      if (!panel.isDestroyed()) {
        panels.push(panel);
        for (const child of panel.#children) visit(child);
      }
    };
    visit(root);
    const handles = panels.map((panel) => panel._getState().windowHandle);
    for (const panel of panels) {
      panel._command({
        type: 'related',
        handles,
        restoreHandle: panel.#parentPanel?._getState().windowHandle ?? ''
      });
    }
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
