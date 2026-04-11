export interface AIDevLogEntry {
  turnId: string;
  kind: string;
  [key: string]: unknown;
}

const KEEPALIVE_BODY_LIMIT_BYTES = 60_000;

export async function appendAIDevLog(entry: AIDevLogEntry): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }

  try {
    const body = JSON.stringify(entry);

    await fetch('/__ai-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      ...(
        getUtf8ByteLength(body) <= KEEPALIVE_BODY_LIMIT_BYTES
          ? { keepalive: true }
          : {}
      ),
    });
  } catch (error) {
    console.warn('[AI] failed to write dev log', error);
  }
}

function getUtf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
