import { NativePanel as DefaultEntryNativePanel, nativeImage } from 'electron';
import { BaseWindow, BrowserWindow, NativePanel, WebContentsView } from 'electron/main';

const parent = new BaseWindow();
const view = new WebContentsView();
parent.contentView.addChildView(view);
const content: Electron.NativePanelContent = {
  type: 'column',
  id: 'root',
  width: 320,
  children: [
    { type: 'text', id: 'title', text: 'Status' },
    { type: 'text', id: 'linked', text: 'Learn more', linkRange: { start: 0, end: 10 } },
    {
      type: 'text',
      id: 'match',
      text: 'GitHub',
      singleLine: true,
      highlights: [{ start: 0, end: 6 }],
      style: { fontWeight: 'medium' }
    },
    {
      type: 'item',
      id: 'result',
      selected: true,
      accessibleName: 'Result',
      style: { radius: 8, hoverBackground: '#F2F1F2', paddingLeft: 8 },
      children: []
    },
    { type: 'iconButton', id: 'microphone', image: nativeImage.createEmpty(), accessibleName: 'Voice input' },
    {
      type: 'button',
      id: 'plain',
      text: 'Action',
      variant: 'plain',
      style: { background: '#00FFFFFF', color: '#123456' }
    },
    { type: 'icon', id: 'icon', image: nativeImage.createEmpty() },
    { type: 'button', id: 'button', text: 'Run' },
    { type: 'toggle', id: 'toggle', text: 'Enabled', checked: true },
    { type: 'input', id: 'query', value: '', placeholder: 'Search', style: { borderless: true } },
    {
      type: 'textarea',
      id: 'body',
      value: 'First line\nSecond line',
      placeholder: 'Write a note',
      maxLength: 0,
      submitOnEnter: true,
      scrollbarPlacement: 'gutter',
      width: 280,
      height: 160,
      style: { borderless: true, paddingTop: 8, paddingLeft: 8 }
    },
    { type: 'button', id: 'save-note', text: 'Save note' },
    { type: 'option', id: 'choice', value: 'a', items: [{ id: 'a', label: 'A' }] },
    { type: 'list', id: 'list', children: [], scrollbarPlacement: 'overlay' },
    { type: 'separator', id: 'separator' },
    { type: 'progress', id: 'progress', value: 0.5 }
  ]
};
const supported: boolean = NativePanel.isSupported();
const ExportedConstructor: typeof NativePanel = DefaultEntryNativePanel;
const panel = new ExportedConstructor({
  parent,
  sourceWebContents: view.webContents,
  content,
  focusMode: 'input',
  backgroundMaterial: 'acrylic',
  scrollbarPlacement: 'gutter'
});
let draft = '';
panel.show({ anchorBounds: { x: 1, y: 2, width: 24, height: 24 }, placement: 'bottom-start' });
panel.update({
  content,
  theme: { mode: 'dark', accent: '#123456', fontSize: 14 },
  radius: 12,
  shadow: true,
  backgroundMaterial: 'none',
  scrollbarPlacement: 'overlay'
});
panel.on('action', (action) => {
  const id: string = action.id;
  const type: string = action.type;
  console.log(id, type, action.value);
  if (id === 'body' && (type === 'change' || type === 'submit') && typeof action.value === 'string') {
    draft = action.value;
  }
  if (id === 'save-note' && type === 'click') {
    console.log(draft);
  }
});
panel.on('dismissed', (details) => console.log(details.reason));
panel.once('closed', () => console.log('closed'));
panel.hide();
panel.destroy();
const requested: boolean = view.webContents.showPageInfoDialog({
  anchorBounds: { x: 1, y: 2, width: 24, height: 24 },
  siteUrl: 'https://example.com'
});
view.webContents.on('page-info-open-site-settings', (event, details) =>
  console.log(event.defaultPrevented, details.origin, details.url)
);
const browserPanel = new NativePanel({ parent: new BrowserWindow(), content, theme: 'system' });
console.log(supported, requested, browserPanel);
