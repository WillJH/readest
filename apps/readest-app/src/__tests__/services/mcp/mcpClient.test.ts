import { describe, it, expect } from 'vitest';
import { parseHeaderLines, serverConfigKey, uniqueToolName } from '@/services/mcp/mcpClient';
import type { AIMcpServer } from '@/services/ai/types';

const server = (over: Partial<AIMcpServer>): AIMcpServer => ({
  id: 's1',
  name: 'Web Search',
  url: 'https://example.com/mcp',
  headers: [],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('parseHeaderLines', () => {
  it('parses Key: Value lines and skips junk', () => {
    expect(
      parseHeaderLines(['Authorization: Bearer tok', 'X-Empty:', 'nocolon', '  K  :  V  ']),
    ).toEqual({ Authorization: 'Bearer tok', 'X-Empty': '', K: 'V' });
  });

  it('tolerates undefined', () => {
    expect(parseHeaderLines(undefined)).toEqual({});
  });
});

describe('serverConfigKey', () => {
  it('changes with url or effective headers, ignores order/formatting noise', () => {
    const a = server({ url: 'https://a/mcp', headers: ['A: 1', 'B: 2'] });
    const b = server({ url: 'https://a/mcp', headers: ['B:2', 'A: 1'] });
    const c = server({ url: 'https://b/mcp', headers: ['A: 1', 'B: 2'] });
    const d = server({ url: 'https://a/mcp', headers: ['A: 1'] });
    expect(serverConfigKey(a)).toBe(serverConfigKey(b));
    expect(serverConfigKey(a)).not.toBe(serverConfigKey(c));
    expect(serverConfigKey(a)).not.toBe(serverConfigKey(d));
  });
});

describe('uniqueToolName', () => {
  it('keeps the bare name when unique', () => {
    expect(uniqueToolName(new Set(['other']), 'Web Search', 'search')).toBe('search');
  });

  it('prefixes with a server slug on collision', () => {
    expect(uniqueToolName(new Set(['search']), 'Web Search', 'search')).toBe('web_search_search');
  });

  it('disambiguates repeated collisions with a counter', () => {
    const taken = new Set(['search', 'web_search_search']);
    expect(uniqueToolName(taken, 'Web Search', 'search')).toBe('web_search_search_2');
  });

  it('slugs non-alphanumeric server names', () => {
    expect(uniqueToolName(new Set(['get']), 'My 搜索 Tool!', 'get')).toBe('my_tool_get');
  });
});
