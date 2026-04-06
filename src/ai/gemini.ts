import { compileGeminiCompilerOpsDraft, type GeminiCompilerOpsDraftResponse } from './compilerOpsDraft';
import { buildGeminiContents, buildGeminiSystemInstruction } from './prompt';
import type { GeminiClientLogEvent, GeminiDraftTurnInput, GeminiDraftTurnResult } from './types';

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

class GeminiRequestFailureError extends Error {
  statusCode?: number;
  responseBody?: string;
  requestExport?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      responseBody?: string;
      requestExport?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'GeminiRequestFailureError';
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.requestExport = options.requestExport;
  }
}

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

  try {
    const requestExport = buildGeminiRequestExport(input, {
      responseJsonSchema: GEMINI_RESPONSE_JSON_SCHEMA,
    });
    const loggedRequestExport = requestExport as unknown as Record<string, unknown>;

    emitLogEvent(input, 'request_started', 'Gemini request started.', {
      requestExport: loggedRequestExport,
    });

    const response = await fetchFn(requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.settings.apiKey,
      },
      body: JSON.stringify(requestExport.requestBody),
      signal: abortController.signal,
    });
    const rawResponseBody = await response.text();
    let payload: GeminiGenerateContentResponse;

    try {
      payload = parseGeminiHttpResponseBody(rawResponseBody);
    } catch (error) {
      throw new GeminiRequestFailureError(
        error instanceof Error ? error.message : 'Gemini returned an invalid HTTP response body.',
        {
          statusCode: response.status,
          responseBody: rawResponseBody,
          requestExport: loggedRequestExport,
        },
      );
    }

    if (!response.ok) {
      const errorMessage = payload.error?.message ?? `Gemini request failed with status ${response.status}.`;
      throw new GeminiRequestFailureError(errorMessage, {
        statusCode: response.status,
        responseBody: rawResponseBody,
        requestExport: loggedRequestExport,
      });
    }

    const rawText = extractGeminiText(payload);
    emitLogEvent(input, 'response_received', 'Gemini response body received.', {
      rawText,
    });
    const parsed = parseGeminiCompilerOpsResponse(rawText);
    emitLogEvent(input, 'response_parsed', `Gemini response parsed in mode "${parsed.mode}".`, {
      rawText,
      responseMode: parsed.mode,
    });

    if (parsed.mode !== 'draft') {
      return {
        response: parsed,
        rawText,
        compilationIssues: [],
      };
    }

    const compiled = compileGeminiCompilerOpsDraft(parsed.ops);

    return {
      response: parsed,
      rawText,
      ...(compiled.value ? { compiledSteps: compiled.value } : {}),
      compilationIssues: compiled.issues,
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
      ...(error instanceof GeminiRequestFailureError && error.requestExport ? { requestExport: error.requestExport } : {}),
      ...(error instanceof GeminiRequestFailureError && typeof error.statusCode === 'number' ? { statusCode: error.statusCode } : {}),
      ...(error instanceof GeminiRequestFailureError && typeof error.responseBody === 'string' ? { responseBody: error.responseBody } : {}),
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
        temperature: 0,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    },
  };
}

export function parseGeminiCompilerOpsResponse(rawText: string): GeminiCompilerOpsDraftResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gemini returned an invalid authoring response.');
  }

  const mode = parsed.mode;
  const msg = parsed.msg;
  const ass = parsed.ass;
  const ops = parsed.ops;

  if (mode !== 'clarify' && mode !== 'draft') {
    throw new Error('Gemini response must include mode "clarify" or "draft".');
  }

  if (typeof msg !== 'string' || msg.trim() === '') {
    throw new Error('Gemini response must include a non-empty msg string.');
  }

  if (!Array.isArray(ass) || ass.some((value) => typeof value !== 'string')) {
    throw new Error('Gemini response must include ass as a string array.');
  }

  if (!Array.isArray(ops) || ops.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) {
    throw new Error('Gemini response must include ops as an object array.');
  }

  if (mode === 'draft' && ops.length === 0) {
    throw new Error('Gemini draft responses must include a non-empty ops array.');
  }

  return {
    mode,
    msg,
    ass,
    ops: ops as GeminiCompilerOpsDraftResponse['ops'],
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
  return {
    $id: 'smt-benchmark-compiler-ops-v1',
    type: 'object',
    additionalProperties: false,
    propertyOrdering: ['mode', 'msg', 'ass', 'ops'],
    properties: {
      mode: {
        type: 'string',
        enum: ['clarify', 'draft'],
        description: 'Use draft when you can propose ops. Use clarify only when a required choice is missing.',
      },
      msg: {
        type: 'string',
        description: 'Short plain-language summary.',
      },
      ass: {
        type: 'array',
        description: 'Assumptions. Return [] when none.',
        items: {
          type: 'string',
        },
      },
      ops: {
        type: 'array',
        description: 'Ordered compiler-friendly operations. Return [] only when mode is clarify.',
        items: {
          $ref: '#/$defs/op',
        },
      },
    },
    required: ['mode', 'msg', 'ass', 'ops'],
    $defs: {
      cid: {
        type: 'string',
        description: 'Column id exactly as provided, for example col_email.',
      },
      hex: {
        type: 'string',
        description: 'Hex fill color such as #ffc7ce.',
      },
      newCol: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['id', 'name'],
        properties: {
          id: {
            type: 'string',
            description: 'New column id.',
          },
          name: {
            type: 'string',
            description: 'New display name.',
          },
        },
        required: ['id', 'name'],
      },
      band: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['lo', 'hi', 'loInc', 'hiInc', 'score'],
        properties: {
          lo: {
            type: ['number', 'null'],
            description: 'Lower bound. null means no lower bound.',
          },
          hi: {
            type: ['number', 'null'],
            description: 'Upper bound. null means no upper bound.',
          },
          loInc: {
            type: 'boolean',
            description: 'Whether the lower bound is inclusive.',
          },
          hiInc: {
            type: 'boolean',
            description: 'Whether the upper bound is inclusive.',
          },
          score: {
            type: 'number',
            description: 'Score to emit for this band.',
          },
        },
        required: ['lo', 'hi', 'loInc', 'hiInc', 'score'],
      },
      fillEmptyFromCol: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['op', 'dst', 'src'],
        properties: {
          op: {
            type: 'string',
            enum: ['fill_empty_from_col'],
          },
          dst: {
            $ref: '#/$defs/cid',
          },
          src: {
            $ref: '#/$defs/cid',
          },
        },
        required: ['op', 'dst', 'src'],
      },
      colorIfEmpty: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['op', 'col', 'color'],
        properties: {
          op: {
            type: 'string',
            enum: ['color_if_empty'],
          },
          col: {
            $ref: '#/$defs/cid',
          },
          color: {
            $ref: '#/$defs/hex',
          },
        },
        required: ['op', 'col', 'color'],
      },
      dropCols: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['op', 'cols'],
        properties: {
          op: {
            type: 'string',
            enum: ['drop_cols'],
          },
          cols: {
            type: 'array',
            items: {
              $ref: '#/$defs/cid',
            },
          },
        },
        required: ['op', 'cols'],
      },
      deriveScoreBands: {
        type: 'object',
        additionalProperties: false,
        propertyOrdering: ['op', 'src', 'out', 'bands'],
        properties: {
          op: {
            type: 'string',
            enum: ['derive_score_bands'],
          },
          src: {
            $ref: '#/$defs/cid',
          },
          out: {
            $ref: '#/$defs/newCol',
          },
          bands: {
            type: 'array',
            items: {
              $ref: '#/$defs/band',
            },
          },
        },
        required: ['op', 'src', 'out', 'bands'],
      },
      op: {
        oneOf: [
          { $ref: '#/$defs/fillEmptyFromCol' },
          { $ref: '#/$defs/colorIfEmpty' },
          { $ref: '#/$defs/dropCols' },
          { $ref: '#/$defs/deriveScoreBands' },
        ],
      },
    },
  };
}

function emitLogEvent(
  input: GeminiDraftTurnInput,
  kind: GeminiClientLogEvent['kind'],
  message: string,
  extra: Partial<Pick<GeminiClientLogEvent, 'rawText' | 'error' | 'responseMode' | 'requestExport' | 'statusCode' | 'responseBody'>> = {},
) {
  input.onLogEvent?.({
    phase: input.phase ?? 'initial',
    kind,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}
