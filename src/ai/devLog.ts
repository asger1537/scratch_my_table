export interface AIDevLogEntry {
  turnId: string;
  kind: string;
  [key: string]: unknown;
}

export async function appendAIDevLog(entry: AIDevLogEntry): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }

  try {
    await fetch('/__ai-log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(entry),
      keepalive: true,
    });
  } catch (error) {
    console.warn('[AI] failed to write dev log', error);
  }
}
