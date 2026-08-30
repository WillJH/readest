/**
 * Desktop loopback wiring of the OAuth authorization-code + PKCE flow: the
 * system browser plus a localhost redirect captured by an ephemeral loopback
 * server (RFC 8252's recommended native-app mechanism).
 *
 * Why this exists alongside {@link runDesktopDeepLinkOAuth}: the reverse-DNS
 * deep link depends on OS scheme routing — the browser must resolve
 * `com.googleusercontent.apps.<id>:` through xdg/portal to the app — and on
 * Linux desktops (Wayland, NVIDIA, assorted browsers) that handoff is exactly
 * where connects silently die. A loopback redirect is a plain `http` URL to
 * `127.0.0.1:<port>`, which every browser opens without any registration; the
 * existing `tauri-plugin-oauth` server (exposed as the `start_server` command)
 * binds the port, captures the redirect, and emits it as a `redirect_uri`
 * window event. The capture is one-shot per attempt and the port is ephemeral.
 *
 * Loopback requires the OAuth client to be a "Desktop app"-type Google client
 * (loopback redirects are pre-authorized for those, any port); the fork's BYO
 * id arrives via `NEXT_PUBLIC_GOOGLE_LOOPBACK_CLIENT_ID`.
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createPkcePair } from './pkce';
import { runOAuthFlow, type OAuthClientConfig } from './oauthFlow';
import { exchangeCode, type FetchFn, type TokenSet } from './tokenEndpoint';

/**
 * Hard deadline after which an unfinished loopback connect gives up and
 * rejects, so the UI spinner clears. The loopback server itself has no
 * timeout, so without this an abandoned sign-in would leave both a pending
 * listener and the spinner alive indefinitely.
 */
export const LOOPBACK_CONNECT_DEADLINE_MS = 15 * 60_000;

/**
 * Platform mechanics the loopback runner needs, injected so the orchestration
 * can be exercised headlessly. The production default binds these to the real
 * Tauri command/plugin; tests pass fakes.
 */
export interface DesktopLoopbackDeps {
  /** Start the loopback server; resolves with the bound port. */
  startLoopbackServer: () => Promise<number>;
  /** Open the consent URL in the user's default browser. */
  openDefaultBrowser: (url: string) => Promise<void>;
  /**
   * Subscribe to loopback redirect URLs for `port`, invoking `onUrl` for each.
   * Resolves with an unlisten function. The runner itself only ever resolves
   * URLs bound to this attempt's port ({@link isLoopbackUrlForPort}), so a
   * subscription may forward everything it sees — an abandoned earlier
   * attempt's still-listening server cannot capture this one.
   */
  subscribeLoopbackRedirects: (port: number, onUrl: (url: string) => void) => Promise<() => void>;
  /** Hard deadline after which an unfinished connect rejects. */
  connectDeadlineMs: number;
}

/**
 * Bind the single-phase loopback capture server (`start_loopback_oauth_server`
 * — captures the callback straight off the first GET's request line, no
 * browser-side JavaScript involved); resolves with the bound port. A malformed
 * port fails fast.
 */
const startServerViaTauri = async (): Promise<number> => {
  const port = await invoke<number>('start_loopback_oauth_server');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Loopback server returned an invalid port: ${String(port)}`);
  }
  console.info('[gdrive] loopback capture server bound on port', port);
  return port;
};

/** Whether a captured URL is this attempt's loopback target (host-exact). */
export const isLoopbackUrlForPort = (url: string, port: number): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(port)
    );
  } catch {
    return false;
  }
};

/** Production capture: the loopback server emits each redirect as a window event. */
const subscribeViaWindowEvents = async (
  port: number,
  onUrl: (url: string) => void,
): Promise<() => void> =>
  getCurrentWindow().listen<string>('redirect_uri', ({ payload }) => {
    if (typeof payload !== 'string') return;
    console.info('[gdrive] loopback redirect_uri event:', payload);
    if (isLoopbackUrlForPort(payload, port)) onUrl(payload);
  });

/** Production loopback deps, bound to the real Tauri command and plugins. */
export const defaultDesktopLoopbackDeps: DesktopLoopbackDeps = {
  startLoopbackServer: startServerViaTauri,
  openDefaultBrowser: (url) => openUrl(url),
  subscribeLoopbackRedirects: subscribeViaWindowEvents,
  connectDeadlineMs: LOOPBACK_CONNECT_DEADLINE_MS,
};

/**
 * Run the desktop loopback OAuth flow and return the resulting tokens: start
 * the ephemeral loopback server, arm the capture, then run the shared flow
 * with `http://127.0.0.1:<port>` as the redirect (the provider appends
 * `?code=&state=` to it; `parseRedirect`'s root-path normalization accepts the
 * bare-host redirect URI).
 *
 * @param config - OAuth client identity + scopes. Only the id/endpoints/params
 *   are used — the reverse-DNS redirect fields are ignored in favour of the
 *   loopback URI.
 * @param fetchFn - platform `fetch` used for the token exchange.
 * @param deps - injected platform mechanics; defaults to the real Tauri wiring.
 */
export const runDesktopLoopbackOAuth = async (
  config: OAuthClientConfig,
  fetchFn: FetchFn,
  deps: DesktopLoopbackDeps = defaultDesktopLoopbackDeps,
): Promise<TokenSet> => {
  const port = await deps.startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${port}`;

  // Armed before `runOAuthFlow` opens the consent URL so the capture cannot
  // race the browser. A browser-open failure must release it too, or the
  // pending listener + deadline would outlive the failed attempt.
  let releaseCapture: (error: unknown) => void = () => {};
  const redirectPromise = new Promise<string>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      unlisten?.();
    };
    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    releaseCapture = fail;

    deps
      .subscribeLoopbackRedirects(port, (url) => {
        if (isLoopbackUrlForPort(url, port)) finish(url);
      })
      .then((dispose) => {
        unlisten = dispose;
        // The redirect can land before `subscribeLoopbackRedirects` resolves
        // its unlisten; dispose immediately if so.
        if (settled) dispose();
      })
      .catch(fail);

    deadline = setTimeout(
      () => fail(new Error('Google sign-in did not complete in time')),
      deps.connectDeadlineMs,
    );
  });
  // The flow may abandon the capture without awaiting it (a browser-open
  // failure rejects the flow before `awaitRedirect` is reached); absorb that
  // path so the release rejection never surfaces as unhandled.
  redirectPromise.catch(() => {});

  return runOAuthFlow(config.scope, {
    createPkcePair,
    newState: () => crypto.randomUUID(),
    clientId: config.clientId,
    openUrl: async (url) => {
      try {
        await deps.openDefaultBrowser(url);
      } catch (error) {
        releaseCapture(error);
        throw error;
      }
    },
    awaitRedirect: () => redirectPromise,
    redirectUri,
    authEndpoint: config.authEndpoint,
    authParams: config.authParams,
    exchange: ({ code, verifier, redirectUri: uri }) =>
      exchangeCode(
        {
          code,
          verifier,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: uri,
          tokenEndpoint: config.tokenEndpoint,
        },
        fetchFn,
      ),
  });
};
