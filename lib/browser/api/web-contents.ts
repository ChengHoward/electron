import { NativePanel } from '@electron/internal/browser/api/native-panel';
import { pageInfoContent } from '@electron/internal/browser/api/page-info';
import type { PageInfoSnapshot } from '@electron/internal/browser/api/page-info';
import {
  openGuestWindow,
  makeWebPreferences,
  parseContentTypeFormat
} from '@electron/internal/browser/guest-window-manager';
import { IpcMainImpl } from '@electron/internal/browser/ipc-main-impl';
import { parseFeatures } from '@electron/internal/browser/parse-features-string';
import nativeImage from '@electron/internal/common/api/native-image';
import shell from '@electron/internal/common/api/shell';
import * as deprecate from '@electron/internal/common/deprecate';

import { app, BaseWindow, webFrameMain, dialog } from 'electron/main';
import type { BrowserWindowConstructorOptions, MessageBoxOptions, NavigationEntry } from 'electron/main';

import * as path from 'path';
import * as url from 'url';
// session is not used here, the purpose of the import is to make sure session
// is initialized before the webContents module.
import '@electron/internal/browser/api/session';

// JavaScript implementations of WebContents.
const binding = process._linkedBinding('electron_browser_web_contents');
const { WebContents } = binding as { WebContents: { prototype: Electron.WebContents } };

const pageInfoPanels = new WeakMap<Electron.WebContents, { destroy: () => void }>();

WebContents.prototype.showPageInfoDialog = function (options) {
  if (!options || typeof options !== 'object' || !options.anchorBounds || typeof options.anchorBounds !== 'object') {
    throw new TypeError('showPageInfoDialog requires anchorBounds');
  }
  const { x, y, width, height } = options.anchorBounds;
  if (
    ![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value)) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new TypeError('anchorBounds must contain finite screen DIP coordinates and positive dimensions');
  }
  let requestedOrigin: string | undefined;
  if (options.siteUrl !== undefined) {
    if (typeof options.siteUrl !== 'string') throw new TypeError('siteUrl must be a URL string');
    try {
      requestedOrigin = new URL(options.siteUrl).origin;
    } catch {
      throw new TypeError('siteUrl must be a valid absolute URL');
    }
    if (requestedOrigin === 'null') throw new TypeError('siteUrl must have a non-opaque origin');
  }
  if (this.isDestroyed()) throw new Error('Cannot show page information for destroyed webContents');

  let invalidated = false;
  let panel: NativePanel | undefined;
  let complete = false;
  const events: NodeJS.EventEmitter = this;
  const cleanup = () => {
    invalidated = true;
    this.removeListener('did-start-navigation', navigationStarted);
    this.removeListener('did-navigate', invalidate);
    this.removeListener('did-navigate-in-page', invalidate);
    this.removeListener('destroyed', invalidate);
    events.removeListener('-owner-window-changed', invalidate);
    events.removeListener('-page-info-security-state-changed', invalidate);
    events.removeListener('-page-info-certificate-closed', destroy);
    if (pageInfoPanels.get(this)?.destroy === destroy) pageInfoPanels.delete(this);
  };
  const destroy = () => {
    invalidated = true;
    cleanup();
    panel?.destroy();
    if (!this.isDestroyed()) this._closeCertificateViewer();
  };
  const invalidate = () => destroy();
  const navigationStarted = (_event: Electron.Event, _url: string, _sameDocument: boolean, isMainFrame: boolean) => {
    if (isMainFrame) invalidate();
  };
  // Register before querying host permission checks: a check handler can
  // synchronously navigate, transfer or destroy the document.
  this.on('did-start-navigation', navigationStarted);
  this.on('did-navigate', invalidate);
  this.on('did-navigate-in-page', invalidate);
  this.on('destroyed', invalidate);
  events.on('-owner-window-changed', invalidate);
  events.on('-page-info-security-state-changed', invalidate);
  try {
    const info: PageInfoSnapshot = this._getPageInfo();
    if (invalidated) throw new Error('Page changed while reading page information');
    if (requestedOrigin !== undefined && requestedOrigin !== info.origin) {
      throw new Error('siteUrl must have the same origin as the committed document');
    }
    const parent = BaseWindow.fromId(info.ownerWindowId);
    if (!parent || parent.isDestroyed()) throw new Error('Page information requires a valid owner window');
    if (!NativePanel.isSupported()) return false;
    pageInfoPanels.get(this)?.destroy();
    panel = new NativePanel({
      parent,
      sourceWebContents: this,
      content: pageInfoContent(info),
      theme: 'system',
      focusMode: 'menu',
      dismissOnOutsideClick: true,
      dismissOnEscape: true
    });
    panel.once('closed', cleanup);
    panel.once('dismissed', destroy);
    panel.on('action', (action: { id: string; type: string }) => {
      if (action.type !== 'click' || invalidated || this.isDestroyed()) {
        return;
      }
      const current: PageInfoSnapshot = this._getPageInfo(false);
      if (
        invalidated ||
        current.documentId !== info.documentId ||
        current.entryId !== info.entryId ||
        current.url !== info.url ||
        current.ownerWindowId !== info.ownerWindowId
      ) {
        destroy();
        return;
      }
      if (action.id === 'page-info-close') return destroy();
      if (action.id === 'page-info-security' || action.id === 'page-info-back') {
        panel!.update({ content: pageInfoContent(info, action.id === 'page-info-security') });
        return;
      }
      if (action.id === 'page-info-description') {
        shell.openExternal('https://support.google.com/chrome/answer/95617').catch((error) => console.error(error));
        return;
      }
      if (action.id === 'page-info-certificate' && info.presentation.chain?.length) {
        panel!.hide();
        events.once('-page-info-certificate-closed', destroy);
        if (!this._showCertificateViewer()) destroy();
        return;
      }
      if (action.id !== 'page-info-site-settings') return;
      destroy();
      const event = {
        sender: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        }
      };
      this.emit('page-info-open-site-settings', event, { url: info.url, origin: info.origin });
    });
    pageInfoPanels.set(this, { destroy });
    if (invalidated) throw new Error('Page changed while opening page information');
    panel.show({ anchorBounds: { x, y, width, height }, placement: 'bottom-start' });
    complete = true;
    return true;
  } finally {
    if (!complete) destroy();
  }
};

function getWebFrame(contents: Electron.WebContents, frame: number | [number, number]) {
  let webFrame: Electron.WebFrameMain | undefined;
  if (typeof frame === 'number') {
    webFrame = webFrameMain.fromId(contents.mainFrame.processId, frame);
  } else if (Array.isArray(frame) && frame.length === 2 && frame.every((value) => typeof value === 'number')) {
    webFrame = webFrameMain.fromId(frame[0], frame[1]);
  } else {
    throw new Error('Missing required frame argument (must be number or [processId, frameId])');
  }
  // Frame ids are global; only address frames that belong to |contents|.
  if (webFrame && webFrame.top !== contents.mainFrame) return undefined;
  return webFrame;
}

WebContents.prototype.sendToFrame = function (frameId, channel, ...args) {
  const frame = getWebFrame(this, frameId);
  if (!frame) return false;
  frame.send(channel, ...args);
  return true;
};

const waitTillCanExecuteJavaScript = async (webContents: Electron.WebContents) => {
  if (webContents.getURL() && !webContents.isLoadingMainFrame()) return;

  return new Promise<void>((resolve) => {
    webContents.once('did-stop-loading', () => {
      resolve();
    });
  });
};

// Make sure WebContents::executeJavaScript would run the code only when the
// WebContents has been loaded.
WebContents.prototype.executeJavaScript = async function (code, hasUserGesture) {
  await waitTillCanExecuteJavaScript(this);
  return this._executeJavaScript(0, [{ code: String(code) }], !!hasUserGesture);
};
WebContents.prototype.executeJavaScriptInIsolatedWorld = async function (worldId, code, hasUserGesture) {
  if (!Number.isInteger(worldId)) throw new TypeError('worldId must be an integer');
  await waitTillCanExecuteJavaScript(this);
  return this._executeJavaScript(worldId, code, !!hasUserGesture);
};

WebContents.prototype.loadFile = function (filePath, options = {}) {
  if (typeof filePath !== 'string') {
    throw new TypeError('Must pass filePath as a string');
  }
  const { query, search, hash } = options;

  return this.loadURL(
    url.format({
      protocol: 'file',
      slashes: true,
      pathname: path.resolve(app.getAppPath(), filePath),
      query,
      search,
      hash
    })
  );
};

type LoadError = { errorCode: number; errorDescription: string; url: string };

function _awaitNextLoad(this: Electron.WebContents, navigationUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const resolveAndCleanup = () => {
      removeListeners();
      resolve();
    };
    let error: LoadError | undefined;
    const rejectAndCleanup = ({ errorCode, errorDescription, url }: LoadError) => {
      const err = new Error(
        `${errorDescription} (${errorCode}) loading '${typeof url === 'string' ? url.substr(0, 2048) : url}'`
      );
      Object.assign(err, { errno: errorCode, code: errorDescription, url });
      removeListeners();
      reject(err);
    };
    const finishListener = () => {
      if (error) {
        rejectAndCleanup(error);
      } else {
        resolveAndCleanup();
      }
    };

    let navigationStarted = false;
    let browserInitiatedInPageNavigation = false;
    const navigationListener = (event: Electron.Event, url: string, isSameDocument: boolean, isMainFrame: boolean) => {
      if (isMainFrame) {
        if (navigationStarted && !isSameDocument) {
          // the webcontents has started another unrelated navigation in the
          // main frame (probably from the app calling `loadURL` again); reject
          // the promise
          // We should only consider the request aborted if the "navigation" is
          // actually navigating and not simply transitioning URL state in the
          // current context.  E.g. pushState and `location.hash` changes are
          // considered navigation events but are triggered with isSameDocument.
          // We can ignore these to allow virtual routing on page load as long
          // as the routing does not leave the document
          return rejectAndCleanup({ errorCode: -3, errorDescription: 'ERR_ABORTED', url });
        }
        browserInitiatedInPageNavigation = navigationStarted && isSameDocument;
        navigationStarted = true;
      }
    };
    const failListener = (
      event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ) => {
      if (!error && isMainFrame) {
        error = { errorCode, errorDescription, url: validatedURL };
      }
      if (!navigationStarted && isMainFrame) {
        finishListener();
      }
    };
    const stopLoadingListener = () => {
      // By the time we get here, either 'finish' or 'fail' should have fired
      // if the navigation occurred. However, in some situations (e.g. when
      // attempting to load a page with a bad scheme), loading will stop
      // without emitting finish or fail. In this case, we reject the promise
      // with a generic failure.
      // TODO(jeremy): enumerate all the cases in which this can happen. If
      // the only one is with a bad scheme, perhaps ERR_INVALID_ARGUMENT
      // would be more appropriate.
      if (!error) {
        error = { errorCode: -2, errorDescription: 'ERR_FAILED', url: navigationUrl };
      }
      finishListener();
    };
    const finishListenerWhenUserInitiatedNavigation = () => {
      if (!browserInitiatedInPageNavigation) {
        finishListener();
      }
    };
    const removeListeners = () => {
      this.removeListener('did-finish-load', finishListener);
      this.removeListener('did-fail-load', failListener);
      this.removeListener('did-navigate-in-page', finishListenerWhenUserInitiatedNavigation);
      this.removeListener('did-start-navigation', navigationListener);
      this.removeListener('did-stop-loading', stopLoadingListener);
      this.removeListener('destroyed', stopLoadingListener);
    };
    this.on('did-finish-load', finishListener);
    this.on('did-fail-load', failListener);
    this.on('did-navigate-in-page', finishListenerWhenUserInitiatedNavigation);
    this.on('did-start-navigation', navigationListener);
    this.on('did-stop-loading', stopLoadingListener);
    this.on('destroyed', stopLoadingListener);
  });
}

WebContents.prototype.loadURLWithResponse = function (url, response) {
  const p = _awaitNextLoad.call(this, url);
  p.catch(() => {});
  this._loadURLWithResponse(url, response ?? {});
  return p;
};

WebContents.prototype.copyVideoFrameAt = function (x: number, y: number) {
  this.mainFrame.copyVideoFrameAt(x, y);
};

WebContents.prototype.saveVideoFrameAs = function (x: number, y: number) {
  this.mainFrame.saveVideoFrameAs(x, y);
};

WebContents.prototype.setWindowOpenHandler = function (
  handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse
) {
  this._windowOpenHandler = handler;
};

/**
 * Intercept page `alert` / `confirm` / `prompt` without injecting into the page
 * or attaching a debugger. Return a response object to handle immediately, or
 * `null`/`undefined` to fall through to the `js-dialog` event / native dialog.
 *
 * Cloudbypass / unofficial Electron extension.
 */
WebContents.prototype.setJsDialogHandler = function (
  handler: ((details: Electron.JsDialogDetails) => Electron.JsDialogResponse | null | undefined) | null
) {
  this._jsDialogHandler = handler;
};

/**
 * Timeout (ms) after `js-dialog` `preventDefault()` if `respond()` is never
 * called. Default 5000. Use 0 to wait indefinitely (not recommended).
 */
WebContents.prototype.setJsDialogTimeout = function (ms: number) {
  this._jsDialogTimeoutMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 5000;
};

WebContents.prototype._callWindowOpenHandler = function (
  event: Electron.Event,
  details: Electron.HandlerDetails
): {
  browserWindowConstructorOptions: BrowserWindowConstructorOptions | null;
  outlivesOpener: boolean;
  createWindow?: Electron.CreateWindowFunction;
} {
  const defaultResponse = {
    browserWindowConstructorOptions: null,
    outlivesOpener: false,
    createWindow: undefined
  };
  if (!this._windowOpenHandler) {
    return defaultResponse;
  }

  const response = this._windowOpenHandler(details);

  if (typeof response !== 'object') {
    event.preventDefault();
    console.error(`The window open handler response must be an object, but was instead of type '${typeof response}'.`);
    return defaultResponse;
  }

  if (response === null) {
    event.preventDefault();
    console.error('The window open handler response must be an object, but was instead null.');
    return defaultResponse;
  }

  if (response.action === 'deny') {
    event.preventDefault();
    return defaultResponse;
  } else if (response.action === 'allow') {
    return {
      browserWindowConstructorOptions:
        typeof response.overrideBrowserWindowOptions === 'object' ? response.overrideBrowserWindowOptions : null,
      outlivesOpener: typeof response.outlivesOpener === 'boolean' ? response.outlivesOpener : false,
      createWindow: typeof response.createWindow === 'function' ? response.createWindow : undefined
    };
  } else {
    event.preventDefault();
    console.error("The window open handler response must be an object with an 'action' property of 'allow' or 'deny'.");
    return defaultResponse;
  }
};

// Deprecation warnings for navigation related APIs.
const canGoBackDeprecated = deprecate.warnOnce('webContents.canGoBack', 'webContents.navigationHistory.canGoBack');
WebContents.prototype.canGoBack = function () {
  canGoBackDeprecated();
  return this._canGoBack();
};

const canGoForwardDeprecated = deprecate.warnOnce(
  'webContents.canGoForward',
  'webContents.navigationHistory.canGoForward'
);
WebContents.prototype.canGoForward = function () {
  canGoForwardDeprecated();
  return this._canGoForward();
};

const canGoToOffsetDeprecated = deprecate.warnOnce(
  'webContents.canGoToOffset',
  'webContents.navigationHistory.canGoToOffset'
);
WebContents.prototype.canGoToOffset = function (index: number) {
  canGoToOffsetDeprecated();
  return this._canGoToOffset(index);
};

const clearHistoryDeprecated = deprecate.warnOnce('webContents.clearHistory', 'webContents.navigationHistory.clear');
WebContents.prototype.clearHistory = function () {
  clearHistoryDeprecated();
  return this._clearHistory();
};

const goBackDeprecated = deprecate.warnOnce('webContents.goBack', 'webContents.navigationHistory.goBack');
WebContents.prototype.goBack = function () {
  goBackDeprecated();
  return this._goBack();
};

const goForwardDeprecated = deprecate.warnOnce('webContents.goForward', 'webContents.navigationHistory.goForward');
WebContents.prototype.goForward = function () {
  goForwardDeprecated();
  return this._goForward();
};

const goToIndexDeprecated = deprecate.warnOnce('webContents.goToIndex', 'webContents.navigationHistory.goToIndex');
WebContents.prototype.goToIndex = function (index: number) {
  goToIndexDeprecated();
  return this._goToIndex(index);
};

const goToOffsetDeprecated = deprecate.warnOnce('webContents.goToOffset', 'webContents.navigationHistory.goToOffset');
WebContents.prototype.goToOffset = function (index: number) {
  goToOffsetDeprecated();
  return this._goToOffset(index);
};

const consoleMessageDeprecated = deprecate.warnOnceMessage(
  "'console-message' arguments are deprecated and will be removed. Please use Event<WebContentsConsoleMessageEventParams> object instead."
);

// Add JavaScript wrappers for WebContents class.
WebContents.prototype._init = function () {
  this._windowOpenHandler = null;
  this._jsDialogHandler = null;
  this._jsDialogTimeoutMs = 5000;

  const ipc = new IpcMainImpl();
  Object.defineProperty(this, 'ipc', {
    get() {
      return ipc;
    },
    enumerable: true
  });

  // Add navigationHistory property which handles session history,
  // maintaining a list of navigation entries for backward and forward navigation.
  Object.defineProperty(this, 'navigationHistory', {
    value: {
      canGoBack: this._canGoBack.bind(this),
      canGoForward: this._canGoForward.bind(this),
      canGoToOffset: this._canGoToOffset.bind(this),
      clear: this._clearHistory.bind(this),
      goBack: this._goBack.bind(this),
      goForward: this._goForward.bind(this),
      goToIndex: this._goToIndex.bind(this),
      goToOffset: this._goToOffset.bind(this),
      getActiveIndex: this._getActiveIndex.bind(this),
      length: this._historyLength.bind(this),
      getEntryAtIndex: this._getNavigationEntryAtIndex.bind(this),
      removeEntryAtIndex: this._removeNavigationEntryAtIndex.bind(this),
      getAllEntries: this._getHistory.bind(this),
      restore: ({ index, entries }: { index?: number; entries: NavigationEntry[] }) => {
        if (index === undefined) {
          index = entries.length - 1;
        }

        if (index < 0 || !entries[index]) {
          throw new Error(
            'Invalid index. Index must be a positive integer and within the bounds of the entries length.'
          );
        }

        try {
          return this._restoreHistory(index, entries);
        } catch (error) {
          return Promise.reject(error);
        }
      }
    },
    writable: false,
    enumerable: true
  });

  if (this.getType() !== 'remote') {
    let windowOpenOverriddenOptions: BrowserWindowConstructorOptions | null = null;
    let windowOpenOutlivesOpenerOption: boolean = false;
    let createWindow: Electron.CreateWindowFunction | undefined;

    this.on('-will-add-new-contents', (event, url, frameName, rawFeatures, disposition, referrer, postData) => {
      const postBody = postData
        ? {
            data: postData,
            ...parseContentTypeFormat(postData)
          }
        : undefined;
      const details: Electron.HandlerDetails = {
        url,
        frameName,
        features: rawFeatures,
        disposition,
        referrer,
        postBody
      };

      let result: ReturnType<typeof this._callWindowOpenHandler>;
      try {
        result = this._callWindowOpenHandler(event, details);
      } catch (err) {
        event.preventDefault();
        throw err;
      }

      windowOpenOutlivesOpenerOption = result.outlivesOpener;
      windowOpenOverriddenOptions = result.browserWindowConstructorOptions;
      createWindow = result.createWindow;
      if (!event.defaultPrevented) {
        const secureOverrideWebPreferences = windowOpenOverriddenOptions
          ? {
              // Allow setting of backgroundColor as a webPreference even though
              // it's technically a BrowserWindowConstructorOptions option because
              // we need to access it in the renderer at init time.
              backgroundColor: windowOpenOverriddenOptions.backgroundColor,
              transparent: windowOpenOverriddenOptions.transparent,
              ...windowOpenOverriddenOptions.webPreferences
            }
          : undefined;
        const { webPreferences: parsedWebPreferences } = parseFeatures(rawFeatures);
        const webPreferences = makeWebPreferences({
          embedder: this,
          insecureParsedWebPreferences: parsedWebPreferences,
          secureOverrideWebPreferences
        });
        windowOpenOverriddenOptions = {
          ...windowOpenOverriddenOptions,
          webPreferences
        };
        this._setNextChildWebPreferences(webPreferences);
      }
    });

    // Create a new browser window for window.open() and for links opened into
    // a new window; both arrive here with the new webContents already created.
    this.on(
      '-add-new-contents',
      (
        event,
        webContents,
        disposition,
        _userGesture,
        _left,
        _top,
        _width,
        _height,
        url,
        frameName,
        referrer,
        rawFeatures,
        postData
      ) => {
        const overriddenOptions = windowOpenOverriddenOptions || undefined;
        const outlivesOpener = windowOpenOutlivesOpenerOption;
        const windowOpenFunction = createWindow;

        createWindow = undefined;
        windowOpenOverriddenOptions = null;
        // false is the default
        windowOpenOutlivesOpenerOption = false;

        if (
          disposition !== 'foreground-tab' &&
          disposition !== 'new-window' &&
          disposition !== 'background-tab' &&
          disposition !== 'save-to-disk'
        ) {
          event.preventDefault();
          return;
        }

        openGuestWindow({
          embedder: this,
          guest: webContents,
          overrideBrowserWindowOptions: overriddenOptions,
          disposition,
          referrer,
          postData,
          windowOpenArgs: {
            url,
            frameName,
            features: rawFeatures
          },
          outlivesOpener,
          createWindow: windowOpenFunction
        });
      }
    );
  }

  const originCounts = new Map<string, number>();
  const openDialogs = new Set<AbortController>();
  this.on('-run-dialog', async (info, callback) => {
    const origin = info.frame.origin === 'file://' ? info.frame.url : info.frame.origin;
    if ((originCounts.get(origin) ?? 0) < 0) return callback(false, '');

    const prefs = this.getLastWebPreferences();
    if (!prefs || prefs.disableDialogs) return callback(false, '');

    const details: Electron.JsDialogDetails = {
      type: info.dialogType,
      message: info.messageText,
      defaultPrompt: info.defaultPromptText,
      url: typeof info.frame?.url === 'string' ? info.frame.url : undefined,
      isMainFrame: info.frame === this.mainFrame
    };

    // 1) Sync handler — preferred for automation (no native UI, no CDP).
    if (typeof this._jsDialogHandler === 'function') {
      try {
        const handled = this._jsDialogHandler(details);
        if (handled != null && typeof handled === 'object' && typeof handled.accept === 'boolean') {
          const promptText =
            handled.promptText != null ? String(handled.promptText) : String(details.defaultPrompt ?? '');
          return callback(!!handled.accept, promptText);
        }
      } catch (err) {
        console.error('js dialog handler threw:', err);
      }
    }

    // 2) Public event — preventDefault() + respond() for async handling.
    let responded = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (accept: boolean, promptText: string) => {
      if (responded || this.isDestroyed()) return;
      responded = true;
      if (timer) clearTimeout(timer);
      callback(accept, promptText);
    };

    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      respond: (response: Electron.JsDialogResponse) => {
        if (!response || typeof response !== 'object' || typeof response.accept !== 'boolean') {
          console.error('js-dialog respond() expects { accept: boolean, promptText?: string }');
          return;
        }
        const promptText =
          response.promptText != null ? String(response.promptText) : String(details.defaultPrompt ?? '');
        finish(!!response.accept, promptText);
      }
    };

    try {
      this.emit('js-dialog', event, details);
    } catch (err) {
      console.error('js-dialog listener threw:', err);
    }

    if (event.defaultPrevented) {
      const timeoutMs = this._jsDialogTimeoutMs ?? 5000;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Safe defaults: accept alert/confirm; accept prompt with default text.
          const promptText = String(details.defaultPrompt ?? '');
          finish(true, promptText);
        }, timeoutMs);
      }
      return;
    }

    // 3) Stock Electron path — native message box.
    // Historical: prompt() was not supported via native UI.
    if (info.dialogType === 'prompt') return callback(false, '');

    originCounts.set(origin, (originCounts.get(origin) ?? 0) + 1);

    // TODO: translate?
    const checkbox =
      originCounts.get(origin)! > 1 && prefs.safeDialogs
        ? prefs.safeDialogsMessage || 'Prevent this app from creating additional dialogs'
        : '';
    const parent = this.getOwnerBrowserWindow();
    const abortController = new AbortController();
    const options: MessageBoxOptions = {
      message: info.messageText,
      checkboxLabel: checkbox,
      signal: abortController.signal,
      ...(info.dialogType === 'confirm'
        ? {
            buttons: ['OK', 'Cancel'],
            defaultId: 0,
            cancelId: 1
          }
        : {
            buttons: ['OK'],
            defaultId: -1, // No default button
            cancelId: 0
          })
    };
    openDialogs.add(abortController);
    const promise =
      parent && !prefs.offscreen ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    try {
      const result = await promise;
      if (abortController.signal.aborted || this.isDestroyed()) return;
      if (result.checkboxChecked) originCounts.set(origin, -1);
      return callback(result.response === 0, '');
    } finally {
      openDialogs.delete(abortController);
    }
  });

  this.on('-cancel-dialogs', () => {
    for (const controller of openDialogs) {
      controller.abort();
    }
    openDialogs.clear();
  });

  (this as NodeJS.EventEmitter).on('newListener', (eventName: string | symbol, listener: (...args: any[]) => void) => {
    if (eventName === 'console-message') {
      // TODO(samuelmaddock): remove deprecated 'console-message' arguments
      if (listener.length > 1) consoleMessageDeprecated();
      if (!this.isDestroyed()) this._setConsoleMessageObserved(true);
    }
  });
  this.on('removeListener' as any, (eventName: string | symbol) => {
    if (eventName === 'console-message' && !this.isDestroyed() && this.listenerCount('console-message') === 0) {
      this._setConsoleMessageObserved(false);
    }
  });
};

// Public APIs.
export function create(options = {}): Electron.WebContents {
  return new (WebContents as any)(options);
}

export function fromId(id: number) {
  return binding.fromId(id);
}

export function fromFrame(frame: Electron.WebFrameMain) {
  return binding.fromFrame(frame);
}

export function fromDevToolsTargetId(targetId: string) {
  return binding.fromDevToolsTargetId(targetId);
}

export function getFocusedWebContents() {
  let focused = null;
  for (const contents of binding.getAllWebContents()) {
    if (!contents.isFocused()) continue;
    if (focused == null) focused = contents;
    // Return webview web contents which may be embedded inside another
    // web contents that is also reporting as focused
    if (contents.getType() === 'webview') return contents;
  }
  return focused;
}
export function getAllWebContents() {
  return binding.getAllWebContents();
}

// Native Agent automation: no debugger, executeJavaScript, or OS activation.
type AgentJob = { run: () => void; cancel: (reason?: string) => void };
type AgentQueue = { running: boolean; jobs: AgentJob[]; active?: Promise<unknown> };
const agentQueues = new WeakMap<Electron.WebContents, AgentQueue>();
const agentGenerations = new WeakMap<Electron.WebContents, number>();
const agentGenerationReasons = new WeakMap<Electron.WebContents, string>();
const agentLifecycleInstalled = new WeakSet<Electron.WebContents>();
const agentResets = new WeakMap<Electron.WebContents, Promise<void>>();
const agentConfigurations = new WeakMap<Electron.WebContents, Promise<void>>();
const automationResetGenerations = new WeakMap<Electron.WebContents, number>();
const agentSequenceCancels = new WeakMap<Electron.WebContents, Set<() => void>>();
const agentDispatchUnqueued = Symbol('agentDispatchUnqueued');
const agentTargetScroll = Symbol('agentTargetScroll');
function agentGeneration(contents: Electron.WebContents): number {
  return agentGenerations.get(contents) || 0;
}
function checkAgentGeneration(contents: Electron.WebContents, generation: number) {
  if (generation !== agentGeneration(contents)) {
    throw new Error(agentGenerationReasons.get(contents) || 'AUTOMATION_RESET');
  }
}
function ensureAgentLifecycle(contents: Electron.WebContents) {
  if (agentLifecycleInstalled.has(contents)) return;
  agentLifecycleInstalled.add(contents);
  contents.on('did-frame-navigate', (_event, _url, _code, _status, mainFrame, processId, routingId) => {
    const state = agentHeldInputs.get(contents);
    if (mainFrame) {
      agentGenerations.set(contents, agentGeneration(contents) + 1);
      agentGenerationReasons.set(contents, 'DOCUMENT_CHANGED');
      for (const job of agentQueues.get(contents)?.jobs.splice(0) || []) job.cancel('DOCUMENT_CHANGED');
      state?.keys.clear();
      state?.buttons.clear();
      if (state) state.touch = undefined;
      releaseAgentInput(contents);
    } else if (state) {
      const belongs = (event: AgentNativeEvent) => {
        const ownerProcess = event._agentOwnerProcessId ?? event._agentProcessId;
        const ownerRouting = event._agentOwnerRoutingId ?? event._agentRoutingId;
        return (
          (ownerProcess === processId && ownerRouting === routingId) ||
          (ownerProcess !== undefined && !getWebFrame(contents, [ownerProcess, ownerRouting]))
        );
      };
      for (const [key, event] of state.keys) if (belongs(event)) state.keys.delete(key);
      for (const [button, event] of state.buttons) if (belongs(event)) state.buttons.delete(button);
      if (state.touch && belongs(state.touch)) state.touch = undefined;
      if (!hasHeldAgentInput(contents)) releaseAgentInput(contents);
    }
  });
}
function queueAgentOperation<T>(
  contents: Electron.WebContents,
  operation: () => Promise<T>,
  cancellation?: { remove?: () => void }
): Promise<T> {
  ensureAgentLifecycle(contents);
  if (agentResets.has(contents)) return Promise.reject(new Error('AUTOMATION_RESET_IN_PROGRESS'));
  const generation = agentGeneration(contents);
  const queue = agentQueues.get(contents) || { running: false, jobs: [] };
  agentQueues.set(contents, queue);
  const drain = () => {
    if (queue.running) return;
    const next = queue.jobs.shift();
    if (next) next.run();
    else agentQueues.delete(contents);
  };
  return new Promise<T>((resolve, reject) => {
    const job: AgentJob = {
      cancel: (reason = 'AUTOMATION_RESET') => reject(new Error(reason)),
      run: () => {
        queue.running = true;
        const active = Promise.resolve()
          .then(() => {
            checkAgentGeneration(contents, generation);
            return operation();
          })
          .then(resolve, reject)
          .finally(() => {
            queue.running = false;
            queue.active = undefined;
            drain();
          });
        queue.active = active;
      }
    };
    if (cancellation) {
      cancellation.remove = () => {
        const index = queue.jobs.indexOf(job);
        if (index < 0) return;
        queue.jobs.splice(index, 1);
        resolve(undefined as T);
      };
    }
    queue.jobs.push(job);
    drain();
  });
}
function validateAutomationOptions(options: Electron.AutomationOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Invalid automation options');
  }
  const fields = ['isolateInput', 'blockRealPointer', 'blockRealKeyboard', 'keepRendering', 'virtualCursor'];
  if (Object.keys(options).some((key) => !fields.includes(key))) throw new TypeError('Unknown automation option');
  for (const name of fields.slice(0, 4) as (keyof Electron.AutomationOptions)[]) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new TypeError(`Invalid ${name}`);
  }
  if (options.virtualCursor !== undefined) {
    const cursor = options.virtualCursor;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).some((key) => !['enabled', 'image', 'hotspot', 'frameRate'].includes(key))
    ) {
      throw new TypeError('Invalid virtualCursor options');
    }
    if (cursor.enabled !== undefined && typeof cursor.enabled !== 'boolean') {
      throw new TypeError('Invalid cursor enabled');
    }
    if (
      cursor.frameRate !== undefined &&
      (!Number.isInteger(cursor.frameRate) || cursor.frameRate < 0 || cursor.frameRate > 1000)
    ) {
      throw new RangeError('Cursor frame rate must be an integer from 0 to 1000');
    }
    if (cursor.hotspot !== undefined) validateInputPoint(cursor.hotspot, 'hotspot');
  }
}
WebContents.prototype.setAutomationOptions = async function (options: Electron.AutomationOptions) {
  validateAutomationOptions(options);
  if (agentResets.has(this)) throw new Error('AUTOMATION_RESET_IN_PROGRESS');
  const snapshot: Electron.AutomationOptions = { ...options };
  if (options.virtualCursor) {
    const cursor = { ...options.virtualCursor };
    if (cursor.hotspot) cursor.hotspot = { ...cursor.hotspot };
    if (cursor.image !== undefined && cursor.image !== null) {
      const size = cursor.image.getSize(1);
      if (size.width < 1 || size.height < 1 || size.width > 512 || size.height > 512) {
        throw new RangeError('Invalid cursor image size');
      }
      cursor.image = nativeImage.createFromBitmap(cursor.image.toBitmap({ scaleFactor: 1 }), {
        ...size,
        scaleFactor: 1
      });
    }
    snapshot.virtualCursor = cursor;
  }
  const generation = automationResetGenerations.get(this) || 0;
  const previous = agentConfigurations.get(this) || Promise.resolve();
  const configured = previous
    .catch(() => {})
    .then(() => {
      if (generation !== (automationResetGenerations.get(this) || 0)) throw new Error('AUTOMATION_RESET');
      if (agentResets.has(this)) throw new Error('AUTOMATION_RESET_IN_PROGRESS');
      return this._setAutomationOptions(snapshot);
    });
  agentConfigurations.set(this, configured);
  try {
    await configured;
  } finally {
    if (agentConfigurations.get(this) === configured) agentConfigurations.delete(this);
  }
};
WebContents.prototype.getAutomationState = function () {
  return this._getAutomationState();
};
WebContents.prototype.resetAutomationOptions = function () {
  const existing = agentResets.get(this);
  if (existing) return existing;
  agentGenerations.set(this, agentGeneration(this) + 1);
  agentGenerationReasons.set(this, 'AUTOMATION_RESET');
  automationResetGenerations.set(this, (automationResetGenerations.get(this) || 0) + 1);
  this._beginAutomationReset();
  agentConfigurations.delete(this);
  const queue = agentQueues.get(this);
  for (const cancel of agentSequenceCancels.get(this) || []) cancel();
  for (const job of queue?.jobs.splice(0) || []) job.cancel();
  const reset = (async () => {
    let failure: unknown;
    try {
      if (queue?.active) await agentDeadline(queue.active, 1500);
    } catch (error) {
      failure = error;
    }
    try {
      await resetAgentInput(this);
    } catch (error) {
      failure ||= error;
    } finally {
      releaseAgentInput(this, true);
    }
    await this._resetAutomationOptions();
    if (failure) throw failure;
  })().finally(() => agentResets.delete(this));
  agentResets.set(this, reset);
  return reset;
};
function validateInputPoint(point: unknown, name: string): asserts point is Electron.Point {
  if (
    !point ||
    typeof point !== 'object' ||
    Array.isArray(point) ||
    Object.keys(point).some((key) => !['x', 'y'].includes(key)) ||
    !['x', 'y'].every(
      (key) =>
        typeof (point as Record<string, unknown>)[key] === 'number' &&
        Number.isFinite((point as Record<string, unknown>)[key]) &&
        Math.abs((point as Record<string, number>)[key]) <= 1000000
    )
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
}
function normalizeMouseCoordinates(event: Record<string, unknown>, allowDefault = false): Record<string, unknown> {
  if ('x' in event || 'y' in event) throw new TypeError('Use position or offset instead of x/y');
  const name = event.target ? 'offset' : 'position';
  const other = event.target ? 'position' : 'offset';
  if (event[other] !== undefined) throw new TypeError(`Cannot use ${other} in this coordinate mode`);
  const point = event[name];
  if (point === undefined && event.target && allowDefault) return { ...event };
  validateInputPoint(point, name);
  const result: Record<string, unknown> = { ...event, x: point.x, y: point.y };
  delete result.position;
  delete result.offset;
  return result;
}
const agentTouchTargets = new WeakMap<Electron.WebContents, string>();
const inputSequenceBudgets = new WeakMap<Electron.WebContents, { count: number; bytes: number }>();
type InputSequenceStep = Electron.InputSequenceMouseStep | Electron.InputSequenceKeyStep;
let nextInputSequenceId = 1;
const mouseStepFields = new Set([
  'kind',
  'atMs',
  'target',
  'type',
  'position',
  'offset',
  'button',
  'buttons',
  'modifiers',
  'clickCount',
  'deltaX',
  'deltaY',
  'pointerType',
  'force',
  'tangentialPressure',
  'tiltX',
  'tiltY',
  'twist'
]);
const keyStepFields = new Set([
  'kind',
  'atMs',
  'target',
  'type',
  'modifiers',
  'text',
  'unmodifiedText',
  'code',
  'key',
  'windowsVirtualKeyCode',
  'nativeVirtualKeyCode',
  'autoRepeat',
  'isKeypad',
  'isSystemKey',
  'location',
  'commands'
]);
const mouseButtonBits: Record<string, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
function sequenceModifier(event: Record<string, unknown>): number {
  const key = String(event.key || event.code || '');
  return key.startsWith('Alt')
    ? 1
    : key.startsWith('Control')
      ? 2
      : key.startsWith('Meta')
        ? 4
        : key.startsWith('Shift')
          ? 8
          : 0;
}
function sequenceKey(event: Record<string, unknown>): string {
  return String(event.code || `${event.key || ''}:${event.windowsVirtualKeyCode || 0}`);
}
function sequenceNumber(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new RangeError(`Invalid input sequence ${name}`);
  }
  return value;
}
function validateInputSteps(steps: InputSequenceStep[]) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 10000) {
    throw new RangeError('Input sequence must contain 1 to 10000 steps');
  }
  steps = structuredClone(steps);
  let previous = 0;
  let buttons = 0;
  const held = new Map<string, number>();
  for (const input of steps) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid input step');
    const step = input as unknown as Record<string, unknown>;
    const fields = step.kind === 'mouse' ? mouseStepFields : step.kind === 'key' ? keyStepFields : null;
    if (!fields || Object.keys(step).some((key) => !fields.has(key))) throw new TypeError('Invalid step kind or field');
    if (step.kind === 'mouse') {
      const normalized = normalizeMouseCoordinates(step, true);
      delete step.position;
      delete step.offset;
      Object.assign(step, normalized);
    }
    previous = sequenceNumber(step.atMs, 'atMs', previous, 60000);
    if (step.target !== undefined) {
      const target = step.target as Record<string, unknown>;
      if (
        !target ||
        typeof target !== 'object' ||
        Array.isArray(target) ||
        Object.keys(target).some(
          (key) => !['webContentsId', 'processId', 'routingId', 'documentId', 'backendNodeId'].includes(key)
        )
      ) {
        throw new TypeError('Invalid input target');
      }
      for (const name of ['webContentsId', 'processId', 'routingId', 'documentId', 'backendNodeId']) {
        sequenceNumber(target[name], name, 0, 2147483647, true);
      }
    }
    if (step.modifiers !== undefined) sequenceNumber(step.modifiers, 'modifiers', 0, 15, true);
    if (step.kind === 'mouse') {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(String(step.type))) {
        throw new TypeError('Invalid mouse type');
      }
      if (!step.target || step.x !== undefined || step.y !== undefined) {
        sequenceNumber(step.x, 'x', -1000000, 1000000);
        sequenceNumber(step.y, 'y', -1000000, 1000000);
      }
      if (step.button !== undefined && !['none', ...Object.keys(mouseButtonBits)].includes(String(step.button))) {
        throw new TypeError('Invalid mouse button');
      }
      const bit = mouseButtonBits[String(step.button)] || 0;
      if (step.type === 'mousePressed') {
        if (!bit || buttons & bit) throw new TypeError('Unbalanced mouse press');
        buttons |= bit;
      }
      if (step.type === 'mouseReleased') {
        if (!bit || !(buttons & bit)) throw new TypeError('Unbalanced mouse release');
        buttons &= ~bit;
      }
      if (step.buttons !== undefined && sequenceNumber(step.buttons, 'buttons', 0, 31, true) !== buttons) {
        throw new TypeError('Mouse buttons conflict with sequence state');
      }
      if (step.clickCount !== undefined) sequenceNumber(step.clickCount, 'clickCount', 0, 3, true);
      if (step.type === 'mouseWheel') {
        sequenceNumber(step.deltaX, 'deltaX', -1000000, 1000000);
        sequenceNumber(step.deltaY, 'deltaY', -1000000, 1000000);
      }
      if (step.pointerType !== undefined && !['mouse', 'pen'].includes(String(step.pointerType))) {
        throw new TypeError('Invalid pointer type');
      }
      for (const [name, min, max] of [
        ['force', 0, 1],
        ['tangentialPressure', -1, 1],
        ['tiltX', -90, 90],
        ['tiltY', -90, 90],
        ['twist', 0, 359]
      ] as const) {
        if (step[name] !== undefined) sequenceNumber(step[name], name, min, max, name === 'twist');
      }
    } else {
      if (!['keyDown', 'rawKeyDown', 'keyUp', 'char'].includes(String(step.type))) {
        throw new TypeError('Invalid key type');
      }
      for (const name of ['text', 'unmodifiedText', 'key', 'code']) {
        if (step[name] === undefined) continue;
        const value = step[name];
        if (typeof value !== 'string' || value.length > (name.endsWith('Text') || name === 'text' ? 3 : 64)) {
          throw new TypeError(`Invalid key ${name}`);
        }
        for (const character of value) {
          const code = character.charCodeAt(0);
          if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new TypeError('Invalid UTF-16 text');
        }
      }
      for (const name of ['autoRepeat', 'isKeypad', 'isSystemKey']) {
        if (step[name] !== undefined && typeof step[name] !== 'boolean') throw new TypeError(`Invalid ${name}`);
      }
      for (const name of ['windowsVirtualKeyCode', 'nativeVirtualKeyCode', 'location']) {
        if (step[name] !== undefined) sequenceNumber(step[name], name, 0, name === 'location' ? 2 : 65535, true);
      }
      if (
        step.commands !== undefined &&
        (!Array.isArray(step.commands) ||
          step.commands.length > 32 ||
          step.commands.some((command) => typeof command !== 'string' || command.length > 128))
      ) {
        throw new TypeError('Invalid key commands');
      }
      const key = sequenceKey(step);
      if (step.type !== 'char' && !step.key && !step.code && !step.windowsVirtualKeyCode) {
        throw new TypeError('Key identity required');
      }
      if (step.type === 'char' && typeof step.text !== 'string') throw new TypeError('Character text required');
      if (step.type === 'keyDown' || step.type === 'rawKeyDown') {
        if (held.has(key) !== !!step.autoRepeat) throw new TypeError('Unbalanced or invalid repeated key');
        held.set(key, sequenceModifier(step));
      } else if (step.type === 'keyUp') {
        if (!held.delete(key)) throw new TypeError('Unbalanced key release');
      }
    }
    let modifiers = 0;
    for (const bit of held.values()) modifiers |= bit;
    if (step.modifiers !== undefined && (Number(step.modifiers) & modifiers) !== modifiers) {
      throw new TypeError('Modifiers conflict with held sequence keys');
    }
  }
  if (buttons || held.size) throw new TypeError('Input sequence must release its buttons and keys');
  const json = JSON.stringify(steps);
  const bytes = Buffer.byteLength(json);
  if (bytes > 4 * 1024 * 1024) throw new RangeError('Input sequence exceeds 4 MiB');
  return { steps, bytes, duration: previous };
}
function unstartedInputResult(
  status: 'cancelled' | 'failed',
  reason: string,
  queueMs: number
): Electron.InputSequenceResult {
  return {
    status,
    reason,
    dispatchedCount: 0,
    mouseCount: 0,
    keyCount: 0,
    lastDispatchedIndex: null,
    stoppedIndex: 0,
    queueMs,
    preparationMs: 0,
    executionMs: 0,
    lateness: { p50: 0, p95: 0, p99: 0, max: 0 },
    cleanup: { dispatched: 0, failed: 0 }
  };
}
WebContents.prototype.dispatchInputSequence = async function (
  steps: InputSequenceStep[],
  options: Electron.InputSequenceOptions = {}
): Promise<Electron.InputSequenceResult> {
  const snapshot = validateInputSteps(steps);
  if (
    !options ||
    typeof options !== 'object' ||
    Object.keys(options).some(
      (key) => !['signal', 'queueTimeoutMs', 'timeoutMs', 'focusTimeoutMs', 'maxLatenessMs'].includes(key)
    )
  ) {
    throw new TypeError('Invalid sequence options');
  }
  const limits = {
    queueTimeoutMs: sequenceNumber(options.queueTimeoutMs ?? 10000, 'queueTimeoutMs', 1, 120000),
    timeoutMs: sequenceNumber(options.timeoutMs ?? Math.max(30000, snapshot.duration + 5000), 'timeoutMs', 1, 120000),
    focusTimeoutMs: sequenceNumber(options.focusTimeoutMs ?? 1000, 'focusTimeoutMs', 1, 10000),
    maxLatenessMs: sequenceNumber(options.maxLatenessMs ?? 250, 'maxLatenessMs', 1, 5000)
  };
  if (snapshot.duration > limits.timeoutMs) throw new RangeError('Sequence duration exceeds timeoutMs');
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('Expected AbortSignal');
  }
  const accepted = performance.now();
  if (signal?.aborted) return unstartedInputResult('cancelled', 'ABORTED', 0);
  const budget = inputSequenceBudgets.get(this) || { count: 0, bytes: 0 };
  if (budget.count >= 16 || budget.bytes + snapshot.bytes > 8 * 1024 * 1024) {
    throw new RangeError('Input sequence queue capacity exceeded');
  }
  budget.count++;
  budget.bytes += snapshot.bytes;
  inputSequenceBudgets.set(this, budget);
  const id = nextInputSequenceId++;
  if (nextInputSequenceId >= 2147483647) nextInputSequenceId = 1;
  return new Promise<Electron.InputSequenceResult>((resolve) => {
    const cancellation: { remove?: () => void } = {};
    let started = false;
    let finished = false;
    const finish = (result: Electron.InputSequenceResult) => {
      if (finished) return;
      finished = true;
      cancellation.remove?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      agentSequenceCancels.get(this)?.delete(abort);
      budget.count--;
      budget.bytes -= snapshot.bytes;
      snapshot.steps.length = 0;
      resolve(result);
    };
    const abort = () => {
      if (finished) return;
      if (started && !this.isDestroyed()) this._cancelInputSequence(id);
      else finish(unstartedInputResult('cancelled', 'ABORTED', performance.now() - accepted));
    };
    const cancels = agentSequenceCancels.get(this) || new Set<() => void>();
    cancels.add(abort);
    agentSequenceCancels.set(this, cancels);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => finish(unstartedInputResult('failed', 'QUEUE_TIMEOUT', performance.now() - accepted)),
      limits.queueTimeoutMs
    );
    queueAgentOperation(
      this,
      async () => {
        if (finished) return;
        started = true;
        clearTimeout(timer);
        const queueMs = performance.now() - accepted;
        if (this.isDestroyed()) {
          finish(unstartedInputResult('failed', 'WEBCONTENTS_DESTROYED', queueMs));
          return;
        }
        if (agentInputLeases.has(this) || hasHeldAgentInput(this)) {
          finish(unstartedInputResult('failed', 'INPUT_STATE_BUSY', queueMs));
          return;
        }
        try {
          const result = await this._runInputSequence(
            snapshot.steps as unknown as Record<string, unknown>[],
            limits,
            id
          );
          finish({ ...result, reason: result.reason.replace(/^Error: /, ''), queueMs, preparationMs: 0 });
        } catch (error) {
          finish(unstartedInputResult('failed', error instanceof Error ? error.message : String(error), queueMs));
        }
      },
      cancellation
    ).catch((error) =>
      finish(
        unstartedInputResult(
          'failed',
          error instanceof Error ? error.message : String(error),
          performance.now() - accepted
        )
      )
    );
  });
};
const agentInputLeases = new WeakMap<Electron.WebContents, { timer: ReturnType<typeof setTimeout> }>();
function releaseAgentInput(contents: Electron.WebContents, force = false) {
  if (!force && hasHeldAgentInput(contents)) return;
  const lease = agentInputLeases.get(contents);
  if (!lease) return;
  clearTimeout(lease.timer);
  agentInputLeases.delete(contents);
  agentTouchTargets.delete(contents);
  if (!contents.isDestroyed()) {
    contents._setAgentInputActive(false);
  }
}
function agentLimit(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError('Invalid Agent limit');
  return value;
}
async function agentDeadline<T>(operation: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('FRAME_TIMEOUT')), timeout);
      })
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
WebContents.prototype.getAgentSnapshot = async function (options: Electron.AgentSnapshotOptions = {}) {
  const maxNodes = agentLimit(options.maxNodes, 1000, 5000);
  const maxFrames = agentLimit(options.maxFrames, 100, 1000);
  const deadline = Date.now() + agentLimit(options.timeoutMs, 5000, 30000);
  const result: Electron.AgentSnapshot = {
    complete: true,
    truncated: false,
    truncationReasons: [],
    frames: [],
    elements: []
  };
  for (const [index, frame] of this.mainFrame.framesInSubtree.entries()) {
    let coverage: Electron.AgentFrameCoverage;
    try {
      coverage = { processId: frame.processId, routingId: frame.routingId, url: frame.url, status: 'covered' };
    } catch {
      result.frames.push({ processId: -1, routingId: -1, url: '', status: 'failed', reason: 'FRAME_DETACHED' });
      result.complete = false;
      continue;
    }
    result.frames.push(coverage);
    const remaining = maxNodes - result.elements.length;
    if (index >= maxFrames || remaining <= 0 || Date.now() >= deadline) {
      coverage.status = 'skipped';
      coverage.reason = index >= maxFrames ? 'MAX_FRAMES' : remaining <= 0 ? 'MAX_NODES' : 'TIME_LIMIT';
      result.complete = false;
      result.truncated = true;
      result.truncationReasons.push(coverage.reason);
      continue;
    }
    try {
      const data = JSON.parse(
        await agentDeadline(
          this._getAgentFrameData(
            frame.processId,
            frame.routingId,
            remaining,
            options.pierce !== false,
            options.selector || ''
          ),
          Math.max(1, deadline - Date.now())
        )
      );
      if (data.error) throw new Error(data.error);
      coverage.documentId = data.documentId;
      if (data.loading) {
        coverage.status = 'partial';
        coverage.reason = 'DOCUMENT_LOADING';
        result.complete = false;
      }
      if (data.truncated) {
        coverage.status = 'partial';
        coverage.reason = data.truncationReasons.join(',');
        result.complete = false;
        result.truncated = true;
        result.truncationReasons.push(...data.truncationReasons);
      }
      for (const item of data.elements) {
        result.elements.push({
          ...item,
          target: {
            webContentsId: this.id,
            processId: frame.processId,
            routingId: frame.routingId,
            documentId: data.documentId,
            backendNodeId: item.backendNodeId
          }
        });
      }
    } catch (error) {
      coverage.status = 'failed';
      coverage.reason = error instanceof Error ? error.message : String(error);
      result.complete = false;
    }
  }
  result.truncationReasons = [...new Set(result.truncationReasons)];
  return result;
};
WebContents.prototype.findAgentElements = async function (
  query: Electron.AgentFindQuery,
  options: Electron.AgentSnapshotOptions = {}
) {
  if (!query || typeof query !== 'object') throw new TypeError('Agent query must be an object');
  const result = await this.getAgentSnapshot({ ...options, selector: query.selector ?? options.selector });
  result.elements = result.elements.filter(
    (item) =>
      (query.role === undefined || item.role === query.role) &&
      (query.name === undefined || item.name.includes(query.name)) &&
      (query.text === undefined || item.text.includes(query.text)) &&
      (query.label === undefined || `${item.labelText} ${item.name}`.includes(query.label)) &&
      (query.disabled === undefined || item.disabled === query.disabled) &&
      (query.checked === undefined || item.checked === query.checked) &&
      (query.selected === undefined || item.selected === query.selected)
  );
  return result;
};
type AgentNativeEvent = Record<string, any>;
const agentOriginalDispatch = new Map<string, (this: Electron.WebContents, event: AgentNativeEvent) => Promise<void>>();
const agentHeldInputs = new WeakMap<
  Electron.WebContents,
  {
    keys: Map<string, AgentNativeEvent>;
    buttons: Map<string, AgentNativeEvent>;
    touch?: AgentNativeEvent;
  }
>();
function heldAgentInputs(contents: Electron.WebContents) {
  ensureAgentLifecycle(contents);
  let state = agentHeldInputs.get(contents);
  if (!state) {
    state = { keys: new Map(), buttons: new Map() };
    agentHeldInputs.set(contents, state);
  }
  return state;
}
function acquireAgentInput(contents: Electron.WebContents) {
  const lease = agentInputLeases.get(contents);
  if (lease) {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => releaseAgentInput(contents), 10000);
  } else {
    agentInputLeases.set(contents, { timer: setTimeout(() => releaseAgentInput(contents), 10000) });
  }
  contents._setAgentInputActive(true);
}
function inferAgentInputState(contents: Electron.WebContents, name: string, event: AgentNativeEvent) {
  const state = heldAgentInputs(contents);
  let modifiers = 0;
  for (const key of state.keys.values()) modifiers |= sequenceModifier(key);
  if (name === 'dispatchKeyEvent') {
    if (event.type === 'keyDown' || event.type === 'rawKeyDown') modifiers |= sequenceModifier(event);
    if (event.type === 'keyUp') modifiers &= ~sequenceModifier(event);
  }
  if (event.modifiers === undefined) event.modifiers = modifiers;
  if (name === 'dispatchMouseEvent' && event.buttons === undefined) {
    let buttons = 0;
    for (const mouse of state.buttons.values()) buttons |= mouseButtonBits[mouse.button] || 0;
    if (event.type === 'mousePressed') buttons |= mouseButtonBits[event.button] || 0;
    if (event.type === 'mouseReleased') buttons &= ~(mouseButtonBits[event.button] || 0);
    event.buttons = buttons;
  }
}
function hasHeldAgentInput(contents: Electron.WebContents) {
  const state = agentHeldInputs.get(contents);
  return !!state && (state.keys.size > 0 || state.buttons.size > 0 || !!state.touch);
}
function rememberAgentInput(contents: Electron.WebContents, name: string, event: AgentNativeEvent) {
  const state = heldAgentInputs(contents);
  let owner: Electron.WebFrameMain | null = null;
  try {
    owner = event._agentProcessId === undefined ? contents.focusedFrame || contents.mainFrame : null;
  } catch {}
  const record = {
    ...event,
    ...(owner ? { _agentOwnerProcessId: owner.processId, _agentOwnerRoutingId: owner.routingId } : {})
  };
  if (name === 'dispatchMouseEvent') {
    if (event.type === 'mousePressed') state.buttons.set(event.button, record);
    if (event.type === 'mouseReleased') state.buttons.delete(event.button);
  } else if (name === 'dispatchKeyEvent') {
    if (event.type === 'keyDown' || event.type === 'rawKeyDown') state.keys.set(sequenceKey(event), record);
    if (event.type === 'keyUp') state.keys.delete(sequenceKey(event));
  } else if (name === 'dispatchTouchEvent') {
    state.touch = event.type === 'touchEnd' || event.type === 'touchCancel' ? undefined : record;
  }
}
async function resetAgentInput(contents: Electron.WebContents) {
  const state = agentHeldInputs.get(contents);
  if (!state || contents.isDestroyed()) return;
  const events: { name: string; event: AgentNativeEvent }[] = [];
  let buttons = 0;
  for (const event of state.buttons.values()) buttons |= mouseButtonBits[event.button] || 0;
  for (const event of state.buttons.values()) {
    buttons &= ~(mouseButtonBits[event.button] || 0);
    events.push({ name: 'dispatchMouseEvent', event: { ...event, type: 'mouseReleased', buttons } });
  }
  let modifiers = 0;
  for (const event of state.keys.values()) modifiers |= sequenceModifier(event);
  const keys = [...state.keys.values()].sort((a, b) => Number(!!sequenceModifier(a)) - Number(!!sequenceModifier(b)));
  for (const event of keys) {
    modifiers &= ~sequenceModifier(event);
    const release: AgentNativeEvent = {
      ...event,
      type: 'keyUp',
      autoRepeat: false,
      text: '',
      unmodifiedText: '',
      commands: [],
      modifiers
    };
    // Key releases follow the current virtual focus after Tab/default focus navigation.
    delete release._agentProcessId;
    delete release._agentRoutingId;
    delete release._agentDocumentToken;
    events.push({ name: 'dispatchKeyEvent', event: release });
  }
  if (state.touch) {
    events.push({ name: 'dispatchTouchEvent', event: { ...state.touch, type: 'touchCancel', touchPoints: [] } });
  }
  let stopped = false;
  const cleanup = async () => {
    let failed = false;
    for (const { name, event } of events) {
      if (stopped) return;
      try {
        await agentOriginalDispatch.get(name)!.call(contents, event);
      } catch {
        failed = true;
      }
    }
    if (stopped) return;
    state.buttons.clear();
    state.keys.clear();
    state.touch = undefined;
    if (failed) throw new Error('AUTOMATION_INPUT_CLEANUP_FAILED');
  };
  try {
    await agentDeadline(cleanup(), 1500);
  } finally {
    stopped = true;
  }
}
for (const name of ['dispatchMouseEvent', 'dispatchKeyEvent', 'dispatchTouchEvent'] as const) {
  const original = WebContents.prototype[name] as unknown as (
    this: Electron.WebContents,
    event: AgentNativeEvent
  ) => Promise<void>;
  agentOriginalDispatch.set(name, original);
  Object.defineProperty(WebContents.prototype, name, {
    configurable: true,
    writable: true,
    value: function (
      this: Electron.WebContents,
      event: AgentNativeEvent & {
        [agentDispatchUnqueued]?: boolean;
        [agentTargetScroll]?: boolean;
      }
    ) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return Promise.reject(new TypeError('Invalid input event'));
      }
      const generation = agentGeneration(this);
      event = { ...event, ...(event.target ? { target: { ...event.target } } : {}) };
      if (Array.isArray(event.commands)) event.commands = [...event.commands];
      try {
        if (name === 'dispatchMouseEvent') event = normalizeMouseCoordinates(event, true);
        if (name === 'dispatchTouchEvent') {
          if (!Array.isArray(event.touchPoints)) throw new TypeError('Invalid touchPoints');
          event = {
            ...event,
            touchPoints: event.touchPoints.map((point: AgentNativeEvent) =>
              normalizeMouseCoordinates({ ...point, target: event.target })
            )
          };
          for (const point of event.touchPoints) delete point.target;
        }
      } catch (error) {
        return Promise.reject(error);
      }
      if (!event.target) {
        const run = async (): Promise<Electron.AgentDispatchResult> => {
          checkAgentGeneration(this, generation);
          const hadLease = agentInputLeases.has(this);
          const starts = ['mousePressed', 'touchStart', 'keyDown', 'rawKeyDown'].includes(event.type);
          const ends = ['mouseReleased', 'touchEnd', 'touchCancel', 'keyUp'].includes(event.type);
          let dispatched = false;
          try {
            acquireAgentInput(this);
            inferAgentInputState(this, name, event);
            if (!['mouseReleased', 'keyUp', 'touchEnd', 'touchCancel'].includes(event.type)) {
              rememberAgentInput(this, name, event);
            }
            await original.call(this, event);
            dispatched = true;
            rememberAgentInput(this, name, event);
            return {
              status: 'dispatched',
              stage: 'event-dispatch',
              stages: [{ stage: 'event-dispatch', status: 'ok' }]
            };
          } catch (error) {
            return {
              status: 'failed',
              stage: 'event-dispatch',
              reason: error instanceof Error ? error.message : String(error),
              stages: [{ stage: 'event-dispatch', status: 'failed' }]
            };
          } finally {
            if ((!dispatched || ends || (!hadLease && !starts)) && !hasHeldAgentInput(this)) releaseAgentInput(this);
          }
        };
        return event[agentDispatchUnqueued] ? run() : queueAgentOperation(this, run);
      }
      const run = async (): Promise<Electron.AgentDispatchResult> => {
        const target = event.target!;
        let stage: Electron.AgentDispatchResult['stage'] = 'target-resolution';
        const stages: Electron.AgentDispatchResult['stages'] = [];
        let dispatched = false;
        const startsSequence =
          event.type === 'mousePressed' ||
          event.type === 'touchStart' ||
          event.type === 'keyDown' ||
          event.type === 'rawKeyDown';
        const endsSequence =
          event.type === 'mouseReleased' ||
          event.type === 'touchEnd' ||
          event.type === 'touchCancel' ||
          event.type === 'keyUp';
        const hadLease = agentInputLeases.has(this);
        try {
          checkAgentGeneration(this, generation);
          if (this.isDestroyed()) throw new Error('WEBCONTENTS_DESTROYED');
          if (hadLease) {
            const lease = agentInputLeases.get(this)!;
            clearTimeout(lease.timer);
            lease.timer = setTimeout(() => releaseAgentInput(this), 10000);
          }
          if (!hadLease) {
            agentInputLeases.set(this, { timer: setTimeout(() => releaseAgentInput(this), 10000) });
          }
          if (
            target.webContentsId !== this.id ||
            ![target.processId, target.routingId, target.documentId, target.backendNodeId].every(Number.isInteger)
          ) {
            throw new Error('INVALID_TARGET');
          }
          this._setAgentInputActive(true);
          inferAgentInputState(this, name, event);
          const info = await agentDeadline(
            this._prepareAgentTarget(
              target.processId,
              target.routingId,
              target.documentId,
              target.backendNodeId,
              name === 'dispatchKeyEvent' && event.type !== 'keyUp',
              event[agentTargetScroll] !== false
            ),
            5000
          );
          if (
            name === 'dispatchKeyEvent' &&
            info.tagName.toLowerCase() === 'select' &&
            (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(event.key || '') || (event.modifiers || 0) & 1)
          ) {
            throw new Error('SELECT_KEY_UNSUPPORTED');
          }
          checkAgentGeneration(this, generation);
          stages.push({ stage, status: 'ok' });
          stage = 'frame-routing';
          if (!getWebFrame(this, [target.processId, target.routingId])) throw new Error('FRAME_UNAVAILABLE');
          const key = `${target.processId}:${target.routingId}:${target.documentId}:${target.backendNodeId}`;
          if (name === 'dispatchTouchEvent' && event.type !== 'touchStart' && agentTouchTargets.get(this) !== key) {
            throw new Error('TOUCH_TARGET_MISMATCH');
          }
          stages.push({ stage, status: 'ok' });
          stage = 'event-dispatch';
          const pointer = name === 'dispatchTouchEvent' && event.touchPoints?.length ? event.touchPoints[0] : event;
          if (
            (pointer.x !== undefined && !Number.isFinite(pointer.x)) ||
            (pointer.y !== undefined && !Number.isFinite(pointer.y))
          ) {
            throw new Error('INVALID_COORDINATES');
          }
          const deviceScale = info.deviceScaleFactor || 1;
          const scale = info.width ? info.bounds.width / info.width / deviceScale : 1;
          const x = info.bounds.x / deviceScale + (pointer.x ?? info.width / 2) * scale;
          const y = info.bounds.y / deviceScale + (pointer.y ?? info.height / 2) * scale;
          const params: AgentNativeEvent = {
            ...event,
            _agentProcessId: target.processId,
            _agentDocumentToken: info.documentToken,
            _agentRoutingId: target.routingId,
            _agentScale: scale,
            _agentLocalX: x,
            _agentLocalY: y,
            x: event.x ?? info.x + info.width / 2,
            y: event.y ?? info.y + info.height / 2
          };
          if (
            name === 'dispatchTouchEvent' &&
            ['touchStart', 'touchMove'].includes(event.type) &&
            !event.touchPoints?.length
          ) {
            throw new Error('TOUCH_POINTS_REQUIRED');
          }
          if (name === 'dispatchKeyEvent' && event.type === 'keyUp') {
            delete (params as AgentNativeEvent)._agentProcessId;
            delete (params as AgentNativeEvent)._agentRoutingId;
            delete (params as AgentNativeEvent)._agentDocumentToken;
          }
          checkAgentGeneration(this, generation);
          if (!['mouseReleased', 'keyUp', 'touchEnd', 'touchCancel'].includes(params.type)) {
            rememberAgentInput(this, name, params);
          }
          try {
            await agentDeadline(original.call(this, params), 5000);
            rememberAgentInput(this, name, params);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'FRAME_TIMEOUT') throw error;
            dispatched = true;
            return {
              status: 'dispatched',
              stage,
              target,
              stages: [...stages, { stage, status: 'ok' }],
              deliveryWarning: 'NATIVE_DISPATCH_ACK_TIMEOUT'
            };
          }
          dispatched = true;
          if (name === 'dispatchTouchEvent') {
            if (event.type === 'touchStart') agentTouchTargets.set(this, key);
            if (event.type === 'touchEnd' || event.type === 'touchCancel') agentTouchTargets.delete(this);
          }
          try {
            await agentDeadline(this._flushAgentInput(target.processId, target.routingId), 5000);
          } catch (error) {
            return {
              status: 'dispatched',
              stage,
              target,
              stages: [...stages, { stage, status: 'ok' }],
              deliveryWarning: error instanceof Error ? error.message : String(error)
            };
          }
          stages.push({ stage, status: 'ok' });
          return { status: 'dispatched', stage, target, stages };
        } catch (error) {
          stages.push({ stage, status: 'failed' });
          return {
            status: 'failed',
            stage,
            target,
            stages,
            reason: error instanceof Error ? error.message : String(error)
          };
        } finally {
          if ((!dispatched || endsSequence || (!hadLease && !startsSequence)) && !hasHeldAgentInput(this)) {
            releaseAgentInput(this);
          }
        }
      };
      return event[agentDispatchUnqueued] ? run() : queueAgentOperation(this, run);
    }
  });
}
const originalAgentQuery = WebContents.prototype.querySelectorAcrossDocuments as (
  this: Electron.WebContents,
  selector: string,
  options?: Electron.QuerySelectorDeepOptions
) => Promise<Electron.DomElementInfo | null>;
Object.defineProperty(WebContents.prototype, 'querySelectorAcrossDocuments', {
  configurable: true,
  writable: true,
  value: async function (
    this: Electron.WebContents,
    selector: string,
    options: Electron.QuerySelectorDeepOptions = {}
  ) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !['pierce', 'scrollIntoView'].includes(key))
    ) {
      throw new TypeError('Invalid query options');
    }
    const match = (await originalAgentQuery.call(this, selector, options)) as
      | (Electron.DomElementInfo & { documentId: number; frameProcessId: number; frameRoutingId: number })
      | null;
    return (
      match && {
        ...match,
        target: {
          webContentsId: this.id,
          processId: match.frameProcessId,
          routingId: match.frameRoutingId,
          documentId: match.documentId,
          backendNodeId: match.backendNodeId
        }
      }
    );
  }
});
Object.defineProperty(WebContents.prototype, 'clickElement', {
  configurable: true,
  writable: true,
  value: async function (this: Electron.WebContents, options: Electron.ClickElementOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('Invalid clickElement options');
    if (
      Object.keys(options).some(
        (key) => !['selector', 'target', 'pierce', 'scrollIntoView', 'button', 'clickCount', 'modifiers'].includes(key)
      ) ||
      (typeof options.selector === 'string') === (options.target !== undefined)
    ) {
      throw new TypeError('Specify exactly one of selector or target');
    }
    const generation = agentGeneration(this);
    const button = options.button ?? 'left';
    const clickCount = options.clickCount ?? 1;
    const modifiers = options.modifiers;
    const buttonMask = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
    if (typeof button !== 'string' || !Object.hasOwn(buttonMask, button)) {
      throw new TypeError('Invalid clickElement button');
    }
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
      throw new RangeError('clickElement clickCount must be an integer from 1 to 3');
    }
    if (modifiers !== undefined && (!Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15)) {
      throw new RangeError('Invalid clickElement modifiers');
    }
    for (const name of ['pierce', 'scrollIntoView'] as const) {
      if (options[name] !== undefined && typeof options[name] !== 'boolean') {
        throw new TypeError(`Invalid clickElement ${name}`);
      }
    }
    const requestedTarget = options.target ? { ...options.target } : undefined;
    const selector = options.selector;
    const scrollIntoView = options.scrollIntoView !== false;
    const lookup = { pierce: options.pierce, scrollIntoView };
    // Queue the entire click, so another target operation cannot interleave
    // between a press and its release, or between the two clicks of a double click.
    return queueAgentOperation(this, async () => {
      checkAgentGeneration(this, generation);
      let target = requestedTarget;
      if (!target) {
        try {
          const match = await this.querySelectorAcrossDocuments(selector!, lookup);
          checkAgentGeneration(this, generation);
          if (!match) throw new Error('No node found');
          target = match.target;
        } catch (error) {
          return {
            status: 'failed' as const,
            stage: 'target-resolution' as const,
            reason: error instanceof Error ? error.message : String(error),
            stages: [{ stage: 'target-resolution', status: 'failed' as const }]
          };
        }
      }
      const base = {
        target,
        button,
        modifiers,
        [agentDispatchUnqueued]: true,
        [agentTargetScroll]: scrollIntoView
      };
      let result: Electron.AgentDispatchResult;
      const warnings = new Set<string>();
      let sent = false;
      for (let count = 1; count <= clickCount; ++count) {
        checkAgentGeneration(this, generation);
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          checkAgentGeneration(this, generation);
          result = await this.dispatchMouseEvent({
            ...base,
            type,
            clickCount: count,
            buttons: type === 'mousePressed' ? buttonMask[button as keyof typeof buttonMask] : 0
          });
          if (result.deliveryWarning) warnings.add(result.deliveryWarning);
          if (result.status === 'failed') {
            if (sent) warnings.add('PARTIAL_CLICK_SEQUENCE');
            return warnings.size ? { ...result, deliveryWarning: [...warnings].join('; ') } : result;
          }
          sent = true;
        }
      }
      return warnings.size ? { ...result!, deliveryWarning: [...warnings].join('; ') } : result!;
    });
  }
});
