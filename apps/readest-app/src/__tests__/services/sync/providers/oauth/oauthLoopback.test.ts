import { describe, expect, test, vi } from 'vitest';
import {
  isLoopbackUrlForPort,
  runDesktopLoopbackOAuth,
  type DesktopLoopbackDeps,
} from '@/services/sync/providers/oauth/oauthLoopback';
import type { OAuthClientConfig } from '@/services/sync/providers/oauth/oauthFlow';

const CLIENT_ID = 'cid.apps.googleusercontent.com';
const PORT = 53123;

// The reverse-DNS redirect fields are intentionally stale here: the loopback
// runner must ignore them in favour of the ephemeral 127.0.0.1 redirect.
const CONFIG: OAuthClientConfig = {
  clientId: CLIENT_ID,
  // Desktop-type Google clients are issued a secret the token endpoint
  // requires; the runner must forward it to the exchange.
  clientSecret: 'GOCSPX-not-really-secret',
  scope: 'drive.file',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  redirectUri: 'com.googleusercontent.apps.cid:/oauthredirect',
  redirectScheme: 'com.googleusercontent.apps.cid',
  authParams: { access_type: 'offline', prompt: 'consent' },
};

const tokenJson = (): Response =>
  new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

interface ExchangeCall {
  code: string;
  verifier: string;
  redirectUri: string;
  clientSecret: string | null;
}

/** A fetch fake that records the token-exchange body params. */
const exchangeFetch = (calls: ExchangeCall[]) =>
  vi.fn(async (_url: unknown, init: { body: string }) => {
    const params = new URLSearchParams(init.body);
    calls.push({
      code: params.get('code') ?? '',
      verifier: params.get('code_verifier') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      clientSecret: params.get('client_secret'),
    });
    return tokenJson();
  }) as unknown as typeof fetch;

const baseDeps = (over: Partial<DesktopLoopbackDeps>): DesktopLoopbackDeps => ({
  startLoopbackServer: vi.fn(async () => PORT),
  openDefaultBrowser: vi.fn(async () => {}),
  subscribeLoopbackRedirects: vi.fn(async () => () => {}),
  connectDeadlineMs: 900_000,
  ...over,
});

// These tests use real (tiny) timeouts rather than fake timers: the PKCE
// challenge runs on `crypto.subtle.digest`, which resolves on Node's threadpool
// and is therefore not flushed by fake timers.
describe('runDesktopLoopbackOAuth', () => {
  test('starts the loopback server, captures the redirect, and exchanges the code', async () => {
    let onUrl!: (url: string) => void;
    const deps = baseDeps({
      subscribeLoopbackRedirects: vi.fn(async (_port, cb) => {
        onUrl = cb;
        return () => {};
      }),
      // Simulate the browser landing on the loopback redirect once consent
      // opens, echoing the exact `state` the flow generated.
      openDefaultBrowser: vi.fn(async (url) => {
        const state = new URL(url).searchParams.get('state');
        queueMicrotask(() => onUrl(`http://127.0.0.1:${PORT}/?code=CODE&state=${state}`));
      }),
    }) as DesktopLoopbackDeps & {
      openDefaultBrowser: ReturnType<typeof vi.fn>;
    };
    const calls: ExchangeCall[] = [];
    const fetchFn = exchangeFetch(calls);

    const tokens = await runDesktopLoopbackOAuth(CONFIG, fetchFn, deps);

    expect(deps.startLoopbackServer).toHaveBeenCalledTimes(1);
    expect(deps.openDefaultBrowser).toHaveBeenCalledTimes(1);
    // The consent URL must target the loopback redirect, not the stale config one.
    const consentUrl = new URL(deps.openDefaultBrowser.mock.calls[0]![0] as string);
    expect(consentUrl.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${PORT}`);
    expect(consentUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(consentUrl.searchParams.get('access_type')).toBe('offline');
    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');
    // The exchange must reuse the loopback redirect verbatim (PKCE requires
    // an exact redirect_uri match) and the captured code, and carry the
    // Desktop-type client's token-endpoint secret.
    expect(calls[0]).toMatchObject({
      code: 'CODE',
      redirectUri: `http://127.0.0.1:${PORT}`,
      clientSecret: 'GOCSPX-not-really-secret',
    });
    expect(calls[0]!.verifier).not.toBe('');
    // The secret never leaks into the consent URL.
    expect(consentUrl.searchParams.has('client_secret')).toBe(false);
  });

  test('ignores a redirect bound to a different loopback port', async () => {
    let onUrl!: (url: string) => void;
    const deps = baseDeps({
      subscribeLoopbackRedirects: vi.fn(async (_port, cb) => {
        onUrl = cb;
        return () => {};
      }),
      openDefaultBrowser: vi.fn(async (url) => {
        const state = new URL(url).searchParams.get('state');
        queueMicrotask(() => {
          // A stale attempt's server (different port) fires first; the flow
          // must keep waiting for this attempt's port.
          onUrl(`http://127.0.0.1:5312/?code=STALE&state=${state}`);
          queueMicrotask(() => onUrl(`http://127.0.0.1:${PORT}/?code=CODE&state=${state}`));
        });
      }),
    });

    const tokens = await runDesktopLoopbackOAuth(CONFIG, exchangeFetch([]), deps);

    expect(tokens.accessToken).toBe('AT');
  });

  test('rejects at the deadline when no redirect ever lands', async () => {
    const deps = baseDeps({ connectDeadlineMs: 50 });
    const result = runDesktopLoopbackOAuth(CONFIG, exchangeFetch([]), deps).catch(
      (e: Error) => e.message,
    );
    await expect(result).resolves.toBe('Google sign-in did not complete in time');
  });

  test('releases the capture when opening the browser fails', async () => {
    const deps = baseDeps({
      openDefaultBrowser: vi.fn(async () => {
        throw new Error('no browser');
      }),
    });
    await expect(runDesktopLoopbackOAuth(CONFIG, exchangeFetch([]), deps)).rejects.toThrow(
      'no browser',
    );
  });
});

describe('isLoopbackUrlForPort', () => {
  test('matches only the exact loopback host and port', () => {
    expect(isLoopbackUrlForPort(`http://127.0.0.1:${PORT}/?code=x`, PORT)).toBe(true);
    // A prefix-sharing port must not false-match.
    expect(isLoopbackUrlForPort('http://127.0.0.1:5312/?code=x', PORT)).toBe(false);
    expect(isLoopbackUrlForPort(`http://localhost:${PORT}/?code=x`, PORT)).toBe(false);
    expect(isLoopbackUrlForPort('not a url', PORT)).toBe(false);
  });
});
