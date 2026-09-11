import { allowAnyProtocol } from '@electron/internal/common/api/net-client-request';

import { ClientRequestConstructorOptions, ClientRequest, IncomingMessage, Session as SessionT } from 'electron/main';

import { Readable, Writable, isReadable } from 'stream';

export type ElectronFetchInit = RequestInit & {
  bypassCustomProtocolHandlers?: boolean;
  /**
   * Optional explicit header name order (matched case-insensitively against
   * `init.headers`). When omitted, object/array insertion order is preserved.
   *
   * This bypasses WHATWG Headers sort-and-combine when applying headers onto
   * Chromium's URLLoader (so session.fetch / net.fetch can match navigation
   * header order).
   */
  headerOrder?: string[];
};

function createDeferredPromise<T, E extends Error = Error>(): {
  promise: Promise<T>;
  resolve: (x: T) => void;
  reject: (e: E) => void;
} {
  let res: (x: T) => void;
  let rej: (e: E) => void;
  const promise = new Promise<T>((resolve, reject) => {
    res = resolve;
    rej = reject;
  });

  return { promise, resolve: res!, reject: rej! };
}

/**
 * Preserve caller header order instead of iterating `Request.headers`
 * (Fetch spec sort-and-combine / lexicographic order).
 */
function headersInOrder(init?: ElectronFetchInit): [string, string][] {
  const h = init?.headers;
  if (!h) return [];

  let pairs: [string, string][];
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    // Already sorted by spec.
    pairs = [...h.entries()];
  } else if (Array.isArray(h)) {
    pairs = h.map(([k, v]) => [String(k), Array.isArray(v) ? v.join(', ') : String(v)]);
  } else {
    pairs = Object.entries(h as Record<string, string | string[]>).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(', ') : String(v)
    ]);
  }

  const order = init?.headerOrder;
  if (!order?.length) return pairs;

  const byLower = new Map<string, [string, string]>();
  for (const p of pairs) byLower.set(p[0].toLowerCase(), p);

  const out: [string, string][] = [];
  const used = new Set<string>();
  for (const name of order) {
    const key = name.toLowerCase();
    const p = byLower.get(key);
    if (p) {
      out.push(p);
      used.add(key);
    }
  }
  for (const p of pairs) {
    if (!used.has(p[0].toLowerCase())) out.push(p);
  }
  return out;
}

export function fetchWithSession(
  input: RequestInfo,
  init: ElectronFetchInit | undefined,
  session: SessionT | undefined,
  request: (options: ClientRequestConstructorOptions | string) => ClientRequest
) {
  const p = createDeferredPromise<Response>();
  let req: Request;
  try {
    req = new Request(input, init);
  } catch (e: any) {
    p.reject(e);
    return p.promise;
  }

  if (req.signal.aborted) {
    // 1. Abort the fetch() call with p, request, null, and
    //    requestObject’s signal’s abort reason.
    const error = (req.signal as any).reason ?? new DOMException('The operation was aborted.', 'AbortError');
    p.reject(error);

    if (req.body != null && isReadable(req.body as unknown as NodeJS.ReadableStream)) {
      req.body.cancel(error).catch((err) => {
        if (err.code === 'ERR_INVALID_STATE') {
          // Node bug?
          return;
        }
        throw err;
      });
    }

    // 2. Return p.
    return p.promise;
  }

  let locallyAborted = false;
  let r: ClientRequest;

  req.signal.addEventListener(
    'abort',
    () => {
      // 1. Set locallyAborted to true.
      locallyAborted = true;

      // 2. Abort the fetch() call with p, request, responseObject,
      //    and requestObject’s signal’s abort reason.
      const error = (req.signal as any).reason ?? new DOMException('The operation was aborted.', 'AbortError');
      p.reject(error);
      if (req.body != null && isReadable(req.body as unknown as NodeJS.ReadableStream)) {
        req.body.cancel(error).catch((err) => {
          if (err.code === 'ERR_INVALID_STATE') {
            // Node bug?
            return;
          }
          throw err;
        });
      }

      r.abort();
    },
    { once: true }
  );

  const origin = req.headers.get('origin') ?? undefined;
  // We can't set credentials to same-origin unless there's an origin set.
  const credentials = req.credentials === 'same-origin' && !origin ? 'include' : req.credentials;

  r = request(
    allowAnyProtocol({
      session,
      method: req.method,
      url: req.url,
      origin,
      credentials,
      cache: req.cache,
      referrerPolicy: req.referrerPolicy,
      redirect: req.redirect
    })
  );

  (r as any)._urlLoaderOptions.bypassCustomProtocolHandlers = !!init?.bypassCustomProtocolHandlers;

  const ordered = headersInOrder(init);
  const hasMode = ordered.some(([k]) => k.toLowerCase() === 'sec-fetch-mode');
  // cors is the default mode, but we can't set mode=cors without an origin.
  // Do not prepend Sec-Fetch-Mode when the caller already set it (preserves order).
  if (!hasMode && req.mode && (req.mode !== 'cors' || origin)) {
    r.setHeader('Sec-Fetch-Mode', req.mode);
  }

  for (const [k, v] of ordered) {
    r.setHeader(k, v);
  }

  r.on('response', (resp: IncomingMessage) => {
    if (locallyAborted) return;
    const headers = new Headers();
    for (const [k, v] of Object.entries(resp.headers)) {
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    const nullBodyStatus = [101, 204, 205, 304];
    const body =
      nullBodyStatus.includes(resp.statusCode) || req.method === 'HEAD'
        ? null
        : (Readable.toWeb(resp as unknown as Readable) as ReadableStream);
    const rResp = new Response(body, {
      headers,
      status: resp.statusCode,
      statusText: resp.statusMessage
    });
    (rResp as any).__original_resp = resp;
    p.resolve(rResp);
  });

  r.on('error', (err) => {
    p.reject(err);
  });

  // pipeTo expects a WritableStream<Uint8Array>. Node.js' Writable.toWeb returns WritableStream<any>,
  // which causes a TS structural mismatch.
  const writable = Writable.toWeb(r as unknown as Writable) as unknown as WritableStream<Uint8Array>;
  if (!req.body?.pipeTo(writable).then(() => r.end())) {
    r.end();
  }

  return p.promise;
}
