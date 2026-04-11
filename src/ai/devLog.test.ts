import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendAIDevLog } from './devLog';

describe('appendAIDevLog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses keepalive for small dev log payloads', async () => {
    const fetchMock = vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    vi.stubGlobal('fetch', fetchMock);

    await appendAIDevLog({
      turnId: 'turn_small',
      kind: 'progress',
      message: 'ok',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/__ai-log',
      expect.objectContaining({
        keepalive: true,
      }),
    );
  });

  it('does not use keepalive for large dev log payloads', async () => {
    const fetchMock = vi.fn<(_url: string, _init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    vi.stubGlobal('fetch', fetchMock);

    await appendAIDevLog({
      turnId: 'turn_large',
      kind: 'turn_result',
      debugTrace: {
        initialRawText: 'x'.repeat(70_000),
      },
    });

    const init = fetchMock.mock.calls[0]?.[1];

    expect(init).toBeDefined();
    expect(init).not.toHaveProperty('keepalive');
  });
});
