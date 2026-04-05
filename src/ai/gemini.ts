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
type GeminiThinkingConfig =
  | {
      thinkingBudget: number;
    }
  | {
      thinkingLevel: 'minimal' | 'high';
    };

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_MODEL_OPTIONS = [
  {
    value: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
  },
  {
    value: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite',
  },
  {
    value: 'gemini-3.1-flash-lite-preview',
    label: 'Gemini 3.1 Flash-Lite Preview',
  },
] as const;
const GEMINI_MODEL_OPTION_VALUES = new Set<string>(GEMINI_MODEL_OPTIONS.map((option) => option.value));
const GEMINI_REQUEST_TIMEOUT_MS = 45_000;
const GEMINI_MAX_OUTPUT_TOKENS = 4096;
const GEMINI_RESPONSE_JSON_SCHEMA = buildGeminiResponseJsonSchema();
const GEMINI_FALLBACK_RESPONSE_JSON_SCHEMA = buildGeminiFallbackResponseJsonSchema();

interface BuildGeminiRequestExportOptions {
  responseJsonSchema?: GeminiResponseJsonSchema;
}

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
      thinkingConfig?: GeminiThinkingConfig;
    };
  };
}

export async function generateGeminiDraftTurn(
  input: GeminiDraftTurnInput,
  fetchFn: typeof fetch = fetch,
): Promise<GeminiDraftTurnResult> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, GEMINI_REQUEST_TIMEOUT_MS);
  const requestAttempts: Array<{
    schema: GeminiResponseJsonSchema;
    variant: 'primary' | 'fallback';
  }> = [
    {
      schema: GEMINI_RESPONSE_JSON_SCHEMA,
      variant: 'primary',
    },
    {
      schema: GEMINI_FALLBACK_RESPONSE_JSON_SCHEMA,
      variant: 'fallback',
    },
  ];

  try {
    for (const attempt of requestAttempts) {
      const requestExport = buildGeminiRequestExport(input, {
        responseJsonSchema: attempt.schema,
      });

      try {
        emitLogEvent(
          input,
          'request_started',
          attempt.variant === 'primary'
            ? 'Gemini request started.'
            : 'Gemini request started with fallback schema after primary schema complexity failure.',
        );
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
          const errorMessage = payload.error?.message ?? `Gemini request failed with status ${response.status}.`;

          if (
            attempt.variant === 'primary'
            && response.status === 400
            && isGeminiSchemaComplexityError(errorMessage)
          ) {
            emitLogEvent(input, 'request_failed', errorMessage, {
              error: errorMessage,
            });
            continue;
          }

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
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }

        if (
          attempt.variant === 'primary'
          && error instanceof Error
          && isGeminiSchemaComplexityError(error.message)
        ) {
          emitLogEvent(input, 'request_failed', error.message, {
            error: error.message,
          });
          continue;
        }

        throw error;
      }
    }

    throw new Error('Gemini request failed after retrying with the fallback schema.');
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

export function buildGeminiRequestExport(
  input: GeminiDraftTurnInput,
  options: BuildGeminiRequestExportOptions = {},
): GeminiRequestExport {
  const systemInstructionText = buildGeminiSystemInstruction(input.context);
  const contents = buildGeminiContents(input.context.messages, input.userMessage);
  const normalizedModel = normalizeGeminiModel(input.settings.model);
  const thinkingConfig = buildThinkingConfig(normalizedModel, input.settings.thinkingEnabled);

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
        responseJsonSchema: options.responseJsonSchema ?? GEMINI_RESPONSE_JSON_SCHEMA,
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

export function normalizeGeminiModelSelection(model: string) {
  const normalizedModel = normalizeGeminiModel(model);
  return GEMINI_MODEL_OPTION_VALUES.has(normalizedModel) ? normalizedModel : DEFAULT_GEMINI_MODEL;
}

function buildThinkingConfig(model: string, thinkingEnabled: boolean): GeminiThinkingConfig | undefined {
  const normalizedModel = model.toLowerCase();

  if (normalizedModel.startsWith('gemini-2.5-flash')) {
    return {
      thinkingBudget: thinkingEnabled ? -1 : 0,
    };
  }

  if (normalizedModel.startsWith('gemini-3') && normalizedModel.includes('flash')) {
    return {
      thinkingLevel: thinkingEnabled ? 'high' : 'minimal',
    };
  }

  return undefined;
}

function buildGeminiResponseJsonSchema(): GeminiResponseJsonSchema {
  return buildGeminiEnvelopeSchema({
    oneOf: buildGeminiDraftStepSchemas(),
  });
}

function buildGeminiFallbackResponseJsonSchema(): GeminiResponseJsonSchema {
  return buildGeminiEnvelopeSchema({
    type: 'object',
    additionalProperties: true,
  });
}

function buildGeminiEnvelopeSchema(stepItemsSchema: GeminiResponseJsonSchema): GeminiResponseJsonSchema {
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
            minLength: 1,
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
            minLength: 1,
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
            items: stepItemsSchema,
          },
        },
        required: ['mode', 'assistantMessage', 'assumptions', 'steps'],
      },
    ],
  };
}

function buildGeminiDraftStepSchemas(): Array<Record<string, unknown>> {
  const stringSchema = {
    type: 'string',
    minLength: 1,
  };
  const stringArraySchema = {
    type: 'array',
    minItems: 1,
    items: stringSchema,
  };
  const expressionStubSchema = buildGeminiExpressionStubSchema();
  const cellPatchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: expressionStubSchema,
      format: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fillColor: {
            type: 'string',
          },
        },
      },
    },
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
      when: expressionStubSchema,
      then: cellPatchSchema,
    },
    required: ['when', 'then'],
  };

  return [
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
        rowCondition: expressionStubSchema,
        cases: {
          type: 'array',
          minItems: 1,
          items: ruleCaseSchema,
        },
        defaultPatch: cellPatchSchema,
      },
      required: ['type', 'columnIds'],
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
        expression: expressionStubSchema,
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
        condition: expressionStubSchema,
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
}

function buildGeminiExpressionStubSchema(): GeminiResponseJsonSchema {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      kind: {
        type: 'string',
        enum: ['value', 'literal', 'column', 'call', 'match'],
      },
      value: {
        type: ['string', 'number', 'boolean', 'null'],
      },
      columnId: {
        type: 'string',
        minLength: 1,
      },
      name: {
        type: 'string',
        minLength: 1,
      },
      subject: {
        type: 'object',
        additionalProperties: true,
      },
      cases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
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
}

function isGeminiSchemaComplexityError(message: string) {
  const normalizedMessage = message.toLowerCase();

  return normalizedMessage.includes('flatten schema')
    || normalizedMessage.includes('schema is too complex')
    || normalizedMessage.includes('maximum nesting depth')
    || normalizedMessage.includes('nesting depth')
    || normalizedMessage.includes('ref loops are only supported');
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
