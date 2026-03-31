import { buildGeminiContents, buildGeminiSystemInstruction } from './prompt';
import type { GeminiClientLogEvent, GeminiDraftTurnInput, GeminiDraftTurnResult, GeminiWorkflowResponse } from './types';

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const GEMINI_RESPONSE_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          const: 'clarify',
        },
        assistantMessage: {
          type: 'string',
        },
        assumptions: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['mode', 'assistantMessage', 'assumptions'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          const: 'draft',
        },
        assistantMessage: {
          type: 'string',
        },
        assumptions: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
          },
        },
      },
      required: ['mode', 'assistantMessage', 'assumptions', 'steps'],
    },
  ],
};

export interface GeminiRequestExport {
  exportedAt: string;
  phase: 'initial' | 'repair';
  model: string;
  requestUrl: string;
  systemInstructionText: string;
  contents: ReturnType<typeof buildGeminiContents>;
  requestBody: {
    systemInstruction: {
      parts: Array<{ text: string }>;
    };
    contents: ReturnType<typeof buildGeminiContents>;
    generationConfig: {
      responseMimeType: 'application/json';
      responseJsonSchema: typeof GEMINI_RESPONSE_JSON_SCHEMA;
      temperature: number;
    };
  };
}

export async function generateGeminiDraftTurn(
  input: GeminiDraftTurnInput,
  fetchFn: typeof fetch = fetch,
): Promise<GeminiDraftTurnResult> {
  try {
    emitLogEvent(input, 'request_started', 'Gemini request started.');
    const requestExport = buildGeminiRequestExport(input);
    const response = await fetchFn(requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.settings.apiKey,
      },
      body: JSON.stringify(requestExport.requestBody),
    });
    const payload = (await response.json()) as GeminiGenerateContentResponse;

    if (!response.ok) {
      const errorMessage = payload.error?.message ?? `Gemini request failed with status ${response.status}.`;

      emitLogEvent(input, 'request_failed', errorMessage, {
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }

    const rawText = extractGeminiText(payload);
    emitLogEvent(input, 'response_received', 'Gemini response body received.', {
      rawText,
    });
    const parsed = parseGeminiWorkflowResponse(rawText);
    emitLogEvent(input, 'response_parsed', `Gemini response parsed in mode "${parsed.mode}".`, {
      rawText,
      responseMode: parsed.mode,
    });

    return {
      response: parsed,
      rawText,
    };
  } catch (error) {
    emitLogEvent(input, 'request_failed', error instanceof Error ? error.message : 'Gemini request failed.', {
      error: error instanceof Error ? error.message : 'Gemini request failed.',
    });
    throw error;
  }
}

export function buildGeminiRequestExport(input: GeminiDraftTurnInput): GeminiRequestExport {
  const systemInstructionText = buildGeminiSystemInstruction(input.context);
  const contents = buildGeminiContents(input.context.messages, input.userMessage);
  const normalizedModel = normalizeGeminiModel(input.settings.model);

  return {
    exportedAt: new Date().toISOString(),
    phase: input.phase ?? 'initial',
    model: normalizedModel,
    requestUrl: buildGeminiUrl(normalizedModel),
    systemInstructionText,
    contents,
    requestBody: {
      systemInstruction: {
        parts: [{ text: systemInstructionText }],
      },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: GEMINI_RESPONSE_JSON_SCHEMA,
        temperature: 0.2,
      },
    },
  };
}

export function parseGeminiWorkflowResponse(rawText: string): GeminiWorkflowResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini returned an invalid workflow response.');
  }

  const mode = parsed.mode;
  const assistantMessage = parsed.assistantMessage;
  const assumptions = parsed.assumptions;
  const steps = parsed.steps;

  if (mode !== 'clarify' && mode !== 'draft') {
    throw new Error('Gemini response must include mode "clarify" or "draft".');
  }

  if (typeof assistantMessage !== 'string' || assistantMessage.trim() === '') {
    throw new Error('Gemini response must include a non-empty assistantMessage string.');
  }

  if (!Array.isArray(assumptions) || assumptions.some((value) => typeof value !== 'string')) {
    throw new Error('Gemini response must include an assumptions string array.');
  }

  if (mode === 'draft') {
    if (!Array.isArray(steps)) {
      throw new Error('Gemini draft responses must include a steps array.');
    }

    return {
      mode,
      assistantMessage,
      assumptions,
      steps: steps as GeminiWorkflowResponse['steps'],
    };
  }

  return {
    mode,
    assistantMessage,
    assumptions,
  };
}

function extractGeminiText(payload: GeminiGenerateContentResponse) {
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();

  if (!text) {
    throw new Error('Gemini returned no candidate text.');
  }

  return text;
}

function stripJsonCodeFence(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  return trimmed;
}

function buildGeminiUrl(model: string) {
  const normalizedModel = normalizeGeminiModel(model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:generateContent`;
}

function normalizeGeminiModel(model: string) {
  return model.trim().replace(/^models\//, '') || DEFAULT_GEMINI_MODEL;
}

function emitLogEvent(
  input: GeminiDraftTurnInput,
  kind: GeminiClientLogEvent['kind'],
  message: string,
  extra: Partial<Pick<GeminiClientLogEvent, 'rawText' | 'error' | 'responseMode'>> = {},
) {
  input.onLogEvent?.({
    phase: input.phase ?? 'initial',
    kind,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}
