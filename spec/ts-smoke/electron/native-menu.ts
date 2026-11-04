import { Menu, BrowserWindow } from 'electron/main';

const controls: Electron.MenuControl[] = [
  { id: 'minus', type: 'button', label: '−', accessibleName: 'Zoom out', group: 1 },
  { id: 'percentage', type: 'label', label: '100%', group: 1 },
  { id: 'plus', type: 'button', label: '+', accessibleName: 'Zoom in', group: 1 }
];
const menu = Menu.buildFromTemplate([{ id: 'zoom', label: 'Zoom', controls }]);
menu.popup({
  window: new BrowserWindow(),
  appearance: { theme: 'light', radius: 16, rowHeight: 30, background: '#FFFFFF' }
});
menu.getMenuItemById('zoom')!.controls = controls;
menu.refresh();
menu.on('control-action', (detail) => {
  const itemId: string = detail.itemId;
  const controlId: string = detail.controlId;
  console.log(itemId, controlId);
});
menu.closePopup();
