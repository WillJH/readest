import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { jsonSchema, tool, type ToolSet } from 'ai';
import type { AIMcpServer } from '@/services/ai/types';

/** A named tool map in the shape streamText expects. */
export type McpToolMap = ToolSet;

interface SessionEntry {
  client: Client;
  /** Config fingerprint — a change forces a reconnect. */
  key: string;
}

interface FailureEntry {
  key: string;
  at: number;
}

const sessions = new Map<string, SessionEntry>();
const failures = new Map<string, FailureEntry>();
/** Retry a failed server at most this often — a dead endpoint must not stall every turn. */
const RETRY_BACKOFF_MS = 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

export function parseHeaderLines(lines: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of lines ?? []) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

export function serverConfigKey(server: AIMcpServer): string {
  const headers = parseHeaderLines(server.headers);
  // Sorted keys: header order is not a semantic change.
  const sorted = Object.keys(headers)
    .sort()
    .map((k) => [k, headers[k]]);
  return JSON.stringify([server.url, sorted]);
}

/** Stable short prefix so same-named tools from different servers don't collide. */
export function uniqueToolName(taken: Set<string>, serverName: string, toolName: string): string {
  const slug =
    serverName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'mcp';
  const prefixed = `${slug}_${toolName}`;
  const candidate = taken.has(toolName) ? prefixed : toolName;
  let final = candidate;
  let n = 2;
  while (taken.has(final)) final = `${candidate}_${n++}`;
  taken.add(final);
  return final;
}

async function connect(server: AIMcpServer): Promise<Client> {
  const headers = parseHeaderLines(server.headers);
  const client = new Client({ name: 'readest', version: '0.12.6' }, { capabilities: {} });
  const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);

  // Streamable HTTP first; fall back to the legacy SSE endpoint shape.
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
    await client.connect(transport, { signal });
    return client;
  } catch (_streamableError) {
    try {
      await client.close();
    } catch {
      // already closed
    }
    const retry = new Client({ name: 'readest', version: '0.12.6' }, { capabilities: {} });
    const sseTransport = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
    await retry.connect(sseTransport, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    return retry;
  }
}

async function ensureSession(server: AIMcpServer): Promise<Client> {
  const key = serverConfigKey(server);
  const existing = sessions.get(server.id);
  if (existing && existing.key === key) return existing.client;
  if (existing) {
    sessions.delete(server.id);
    void existing.client.close().catch(() => {});
  }
  const failed = failures.get(server.id);
  if (failed && failed.key === key && Date.now() - failed.at < RETRY_BACKOFF_MS) {
    throw new Error('MCP server recently failed; backing off');
  }
  try {
    const client = await connect(server);
    sessions.set(server.id, { client, key });
    failures.delete(server.id);
    return client;
  } catch (err) {
    failures.set(server.id, { key, at: Date.now() });
    throw err;
  }
}

/**
 * Collect tools from every enabled server as a streamText tool map. A server
 * that is down or malformed is skipped (warned) — the chat proceeds with
 * whatever tools are available.
 */
export async function getMcpTools(servers: AIMcpServer[]): Promise<McpToolMap> {
  const tools: McpToolMap = {};
  const taken = new Set<string>();
  await Promise.all(
    servers
      .filter((s) => s.enabled && !s.deletedAt && s.url)
      .map(async (server) => {
        try {
          const client = await ensureSession(server);
          const listed = await client.listTools();
          for (const t of listed.tools ?? []) {
            const name = uniqueToolName(taken, server.name, t.name);
            const schema =
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object' as const, properties: {} };
            tools[name] = tool({
              description: `[${server.name}] ${t.description ?? t.name}`,
              inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
              execute: async (args: unknown) => {
                const result = await client.callTool({
                  name: t.name,
                  arguments: (args ?? {}) as Record<string, unknown>,
                });
                const content = (result as { content?: unknown }).content;
                return content === undefined ? result : content;
              },
            });
          }
        } catch (err) {
          console.warn(`[MCP] ${server.name} unavailable:`, err);
        }
      }),
  );
  return tools;
}

/** One-off connectivity probe for the settings UI. */
export async function testMcpServer(
  server: AIMcpServer,
): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
  try {
    const client = await connect(server);
    try {
      const listed = await client.listTools();
      return { ok: true, toolCount: listed.tools?.length ?? 0 };
    } finally {
      void client.close().catch(() => {});
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop sessions for servers that were removed or disabled. */
export function pruneMcpSessions(activeIds: Set<string>): void {
  for (const id of [...sessions.keys()]) {
    if (!activeIds.has(id)) {
      const entry = sessions.get(id);
      sessions.delete(id);
      failures.delete(id);
      void entry?.client.close().catch(() => {});
    }
  }
}
