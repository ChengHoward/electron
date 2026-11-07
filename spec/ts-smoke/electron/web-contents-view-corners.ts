import { View, WebContentsView } from 'electron/main';

const view = new WebContentsView();
view.setBorderRadius(12);
view.setBorderRadius(12, { scrollbarInset: 6 });
view.setBorderRadius(12, { scrollbarInset: 0 });
view.setBorderRadius(12, { scrollbarInset: null });
view.setBorderRadius(12, {});
const base: View = view;
base.setBorderRadius(12);
// @ts-expect-error Insets accept numbers or null, not text.
view.setBorderRadius(12, { scrollbarInset: '6' });
