import type { NativePanelContent as Node } from 'electron/main';

export type PageInfoSnapshot = {
  url: string;
  origin: string;
  host: string;
  entryId: number;
  documentId: string;
  ownerWindowId: number;
  securityState: string;
  protocol?: string;
  cipher?: string;
  certificate?: Electron.Certificate;
  permissions: { id: string; allowed: boolean; source: 'host-check' }[];
  presentation: Record<string, any>;
  icons: Record<string, Electron.NativeImage>;
};

const label = (id: string, text: string, extra: Partial<Node> = {}): Node => ({ type: 'text', id, text, ...extra });
const inset = { paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10 };

export function pageInfoContent(info: PageInfoSnapshot, security = false): Node {
  const s = info.presentation;
  const icon = (id: string, name: string): Node => ({
    type: 'icon',
    id,
    image: info.icons[name],
    width: 20,
    height: 20
  });
  const button = (id: string, name: string, accessibleName: string): Node => ({
    type: 'iconButton',
    id,
    image: info.icons[name],
    accessibleName,
    tooltip: accessibleName,
    width: 28,
    height: 28
  });
  const row = (id: string, name: string, text: string, trailing: string): Node => ({
    type: 'item',
    id,
    height: 42,
    gap: 12,
    accessibleName: text,
    style: inset,
    children: [
      icon(`${id}-icon`, name),
      label(`${id}-text`, text, { flex: 1, singleLine: true }),
      icon(`${id}-end`, trailing)
    ]
  });
  const title: Node[] = [];
  if (security) title.push(button('page-info-back', 'back', s.back));
  title.push(
    {
      type: 'column',
      id: 'page-info-heading',
      flex: 1,
      gap: 2,
      children: [
        label('page-info-title', security ? s.security : info.host || info.origin, { fontSize: 17, singleLine: true }),
        ...(security ? [label('page-info-origin', info.host || info.origin, { fontSize: 12, singleLine: true })] : [])
      ]
    },
    button('page-info-close', 'close', s.close)
  );
  const children: Node[] = [
    { type: 'row', id: 'page-info-header', gap: 8, padding: security ? 14 : 8, children: title }
  ];
  const secure = info.securityState === 'secure';
  if (security) {
    children.push(
      { type: 'separator', id: 'page-info-header-separator' },
      {
        type: 'row',
        id: 'page-info-security-body',
        gap: 12,
        padding: 10,
        style: { align: 'start', paddingTop: 20 },
        children: [
          icon('page-info-lock', secure ? 'lock' : 'warning'),
          {
            type: 'column',
            id: 'page-info-security-copy',
            flex: 1,
            gap: 6,
            children: [
              label('page-info-security', s.summary),
              label('page-info-description', `${s.description} ${s.learnMore}`, {
                fontSize: 12,
                linkRange: { start: s.description.length + 1, end: s.description.length + 1 + s.learnMore.length }
              })
            ]
          }
        ]
      }
    );
    if (info.certificate) {
      children.push(
        row('page-info-certificate', 'certificate', secure ? s.certificate : s.invalidCertificate, 'launch')
      );
    }
  } else {
    children.push(
      row('page-info-security', secure ? 'lock' : 'warning', s.summary, 'next'),
      row('page-info-site-settings', 'settings', s.settings, 'launch')
    );
  }
  return { type: 'column', id: 'page-info', width: 322, gap: 0, children };
}
