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

type GeminiResponseJsonSchema = Record<string, unknown>;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_REQUEST_TIMEOUT_MS = 45_000;
const GEMINI_MAX_OUTPUT_TOKENS = 1024;
const GEMINI_RESPONSE_JSON_SCHEMA = buildGeminiResponseJsonSchema();

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
      responseJsonSchema: GeminiResponseJsonSchema;
      temperature: number;
      maxOutputTokens: number;
      thinkingConfig?: {
        thinkingBudget: number;
      };
    };
  };
}

export async function generateGeminiDraftTurn(
  input: GeminiDraftTurnInput,
  fetchFn: typeof fetch = fetch,
): Promise<GeminiDraftTurnResult> {
  const requestExport = buildGeminiRequestExport(input);
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, GEMINI_REQUEST_TIMEOUT_MS);

  try {
    emitLogEvent(input, 'request_started', 'Gemini request started.');
    const response = await fetchFn(requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.settings.apiKey,
      },
      body: JSON.stringify(requestExport.requestBody),
      signal: abortController.signal,
    });
    const payload = parseGeminiHttpResponseBody(await response.text());

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Gemini request failed with status ${response.status}.`);
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
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timeoutMessage = `Gemini request timed out after ${Math.floor(GEMINI_REQUEST_TIMEOUT_MS / 1000)} seconds.`;

      emitLogEvent(input, 'request_failed', timeoutMessage, {
        error: timeoutMessage,
      });
      throw new Error(timeoutMessage);
    }

    emitLogEvent(input, 'request_failed', error instanceof Error ? error.message : 'Gemini request failed.', {
      error: error instanceof Error ? error.message : 'Gemini request failed.',
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildGeminiRequestExport(input: GeminiDraftTurnInput): GeminiRequestExport {
  const systemInstructionText = buildGeminiSystemInstruction(input.context);
  const contents = buildGeminiContents(input.context.messages, input.userMessage);
  const normalizedModel = normalizeGeminiModel(input.settings.model);
  const thinkingConfig = buildThinkingConfig(normalizedModel);

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
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        ...(thinkingConfig ? { thinkingConfig } : {}),
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

function parseGeminiHttpResponseBody(rawBody: string): GeminiGenerateContentResponse {
  try {
    return JSON.parse(rawBody) as GeminiGenerateContentResponse;
  } catch {
    const compactPreview = rawBody.replace(/\s+/g, ' ').trim().slice(0, 280);
    throw new Error(
      compactPreview === ''
        ? 'Gemini returned an invalid empty HTTP response body.'
        : `Gemini returned an invalid JSON HTTP response body. Preview: ${compactPreview}`,
    );
  }
}

function buildGeminiUrl(model: string) {
  const normalizedModel = normalizeGeminiModel(model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${normalizedModel}:generateContent`;
}

function normalizeGeminiModel(model: string) {
  return model.trim().replace(/^models\//, '') || DEFAULT_GEMINI_MODEL;
}

function buildThinkingConfig(model: string) {
  const normalizedModel = model.toLowerCase();

  if (normalizedModel.startsWith('gemini-2.5-flash')) {
    // Workflow drafting is latency-sensitive and the output is tightly schema-bound.
    return {
      thinkingBudget: 0,
    };
  }

  return undefined;
}

function buildGeminiResponseJsonSchema(): GeminiResponseJsonSchema {
  const stringSchema = {
    type: 'string',
    minLength: 1,
  };
  const stringArraySchema = {
    type: 'array',
    minItems: 1,
    items: stringSchema,
  };
  const scalarSchema = {
    type: ['string', 'number', 'boolean', 'null'],
  };
  const expressionSchema = {
    type: 'object',
    additionalProperties: true,
    properties: {
      kind: {
        type: 'string',
        enum: ['value', 'literal', 'column', 'call'],
      },
      value: scalarSchema,
      columnId: stringSchema,
      name: stringSchema,
      args: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
    required: ['kind'],
  };
  const cellFormatPatchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      fillColor: {
        type: 'string',
      },
    },
  };
  const cellPatchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: expressionSchema,
      format: cellFormatPatchSchema,
    },
    anyOf: [
      {
        required: ['value'],
      },
      {
        required: ['format'],
      },
    ],
  };
  const columnSpecSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      columnId: stringSchema,
      displayName: stringSchema,
    },
    required: ['columnId', 'displayName'],
  };
  const sortKeySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      columnId: stringSchema,
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
      },
    },
    required: ['columnId', 'direction'],
  };
  const ruleCaseSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      when: expressionSchema,
      then: cellPatchSchema,
    },
    required: ['when', 'then'],
  };
  const draftStepSchemas = [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'comment',
        },
        text: stringSchema,
      },
      required: ['type', 'text'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'scopedRule',
        },
        columnIds: stringArraySchema,
        rowCondition: expressionSchema,
        cases: {
          type: 'array',
          minItems: 1,
          items: ruleCaseSchema,
        },
        defaultPatch: cellPatchSchema,
      },
      required: ['type', 'columnIds'],
      anyOf: [
        {
          required: ['cases'],
        },
        {
          required: ['defaultPatch'],
        },
      ],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'dropColumns',
        },
        columnIds: stringArraySchema,
      },
      required: ['type', 'columnIds'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'renameColumn',
        },
        columnId: stringSchema,
        newDisplayName: stringSchema,
      },
      required: ['type', 'columnId', 'newDisplayName'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'deriveColumn',
        },
        newColumn: columnSpecSchema,
        expression: expressionSchema,
      },
      required: ['type', 'newColumn', 'expression'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'filterRows',
        },
        mode: {
          type: 'string',
          enum: ['keep', 'drop'],
        },
        condition: expressionSchema,
      },
      required: ['type', 'mode', 'condition'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'splitColumn',
        },
        columnId: stringSchema,
        delimiter: stringSchema,
        outputColumns: {
          type: 'array',
          minItems: 2,
          items: columnSpecSchema,
        },
      },
      required: ['type', 'columnId', 'delimiter', 'outputColumns'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'combineColumns',
        },
        columnIds: {
          type: 'array',
          minItems: 2,
          items: stringSchema,
        },
        separator: {
          type: 'string',
        },
        newColumn: columnSpecSchema,
      },
      required: ['type', 'columnIds', 'separator', 'newColumn'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'deduplicateRows',
        },
        columnIds: stringArraySchema,
      },
      required: ['type', 'columnIds'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: {
          type: 'string',
          const: 'sortRows',
        },
        sorts: {
          type: 'array',
          minItems: 1,
          items: sortKeySchema,
        },
      },
      required: ['type', 'sorts'],
    },
  ];

  return {
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
              oneOf: draftStepSchemas,
            },
          },
        },
        required: ['mode', 'assistantMessage', 'assumptions', 'steps'],
      },
    ],
  };
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
