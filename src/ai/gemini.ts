import { compileAuthoringDraft } from './compileAuthoringDraft';
import { type AuthoringDraftResponse } from './authoringIr';
import { buildGeminiContents, buildGeminiSystemInstruction, type GeminiPromptOptions } from './prompt';
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
  promptOptions?: GeminiPromptOptions;
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
    const parsed = parseGeminiAuthoringResponse(rawText);
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

    const compiled = compileAuthoringDraft(parsed.steps);

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
  const systemInstructionText = buildGeminiSystemInstruction(input.context, options.promptOptions);
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

export function parseGeminiAuthoringResponse(rawText: string): AuthoringDraftResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini returned an invalid authoring response.');
  }

  const mode = parsed.mode;
  const msg = parsed.msg;
  const ass = parsed.ass;
  const steps = parsed.steps;

  if (mode !== 'clarify' && mode !== 'draft') {
    throw new Error('Gemini response must include mode "clarify" or "draft".');
  }

  if (typeof msg !== 'string' || msg.trim() === '') {
    throw new Error('Gemini response must include a non-empty msg string.');
  }

  if (!Array.isArray(ass) || ass.some((value) => typeof value !== 'string')) {
    throw new Error('Gemini response must include ass as a string array.');
  }

  if (!Array.isArray(steps) || steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) {
    throw new Error('Gemini response must include steps as an object array.');
  }

  if (mode === 'draft' && steps.length === 0) {
    throw new Error('Gemini draft responses must include a non-empty steps array.');
  }

  return {
    mode,
    msg,
    ass,
    steps: steps as AuthoringDraftResponse['steps'],
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
    $id: 'smt-authoring-ir-v1',
    type: 'object',
    additionalProperties: false,
    propertyOrdering: ['mode', 'msg', 'ass', 'steps'],
    properties: {
      mode: {
        type: 'string',
        enum: ['clarify', 'draft'],
      },
      msg: {
        type: 'string',
      },
      ass: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
      steps: {
        type: 'array',
        items: {
          oneOf: [
            buildCommentStepSchema(),
            buildScopedRuleStepSchema(),
            buildDropColumnsStepSchema(),
            buildRenameColumnStepSchema(),
            buildDeriveColumnStepSchema(),
            buildFilterRowsStepSchema(),
            buildSplitColumnStepSchema(),
            buildCombineColumnsStepSchema(),
            buildDeduplicateRowsStepSchema(),
            buildSortRowsStepSchema(),
          ],
        },
      },
    },
    required: ['mode', 'msg', 'ass', 'steps'],
  };
}

function buildCommentStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['comment'],
      },
      text: {
        type: 'string',
      },
    },
    required: ['type', 'text'],
  };
}

function buildScopedRuleStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['scopedRule'],
      },
      columnIds: buildStringArraySchema(),
      rowWhere: buildAuthoringBooleanExpressionSchema(),
      cases: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            when: buildAuthoringBooleanExpressionSchema(),
            then: buildAuthoringCellPatchSchema(),
          },
          required: ['when', 'then'],
        },
      },
      defaultPatch: buildAuthoringCellPatchSchema(),
    },
    required: ['type', 'columnIds'],
  };
}

function buildDropColumnsStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['dropColumns'],
      },
      columnIds: buildStringArraySchema(),
    },
    required: ['type', 'columnIds'],
  };
}

function buildRenameColumnStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['renameColumn'],
      },
      columnId: {
        type: 'string',
      },
      newDisplayName: {
        type: 'string',
      },
    },
    required: ['type', 'columnId', 'newDisplayName'],
  };
}

function buildDeriveColumnStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['deriveColumn'],
      },
      newColumn: buildNewColumnSchema(),
      derive: buildAuthoringValueInputSchema(),
    },
    required: ['type', 'newColumn', 'derive'],
  };
}

function buildFilterRowsStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['filterRows'],
      },
      mode: {
        type: 'string',
        enum: ['keep', 'drop'],
      },
      where: buildAuthoringBooleanExpressionSchema(),
    },
    required: ['type', 'mode', 'where'],
  };
}

function buildSplitColumnStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['splitColumn'],
      },
      columnId: {
        type: 'string',
      },
      delimiter: {
        type: 'string',
      },
      outputColumns: {
        type: 'array',
        items: buildNewColumnSchema(),
      },
    },
    required: ['type', 'columnId', 'delimiter', 'outputColumns'],
  };
}

function buildCombineColumnsStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['combineColumns'],
      },
      columnIds: buildStringArraySchema(),
      separator: {
        type: 'string',
      },
      newColumn: buildNewColumnSchema(),
    },
    required: ['type', 'columnIds', 'separator', 'newColumn'],
  };
}

function buildDeduplicateRowsStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['deduplicateRows'],
      },
      columnIds: buildStringArraySchema(),
    },
    required: ['type', 'columnIds'],
  };
}

function buildSortRowsStepSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['sortRows'],
      },
      sorts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            columnId: {
              type: 'string',
            },
            direction: {
              type: 'string',
              enum: ['asc', 'desc'],
            },
          },
          required: ['columnId', 'direction'],
        },
      },
    },
    required: ['type', 'sorts'],
  };
}

function buildNewColumnSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      columnId: {
        type: 'string',
      },
      displayName: {
        type: 'string',
      },
    },
    required: ['columnId', 'displayName'],
  };
}

function buildAuthoringCellPatchSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: buildAuthoringValueInputSchema(),
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
}

function buildAuthoringValueInputSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      source: {
        type: 'string',
        enum: ['column', 'value', 'caseValue', 'literal'],
      },
      kind: {
        type: 'string',
        enum: ['nullary', 'unary', 'binary', 'ternary', 'nary', 'match'],
      },
      op: {
        type: 'string',
        enum: [
          'now',
          'trim',
          'lower',
          'upper',
          'toNumber',
          'toString',
          'toBoolean',
          'collapseWhitespace',
          'first',
          'last',
          'round',
          'floor',
          'ceil',
          'abs',
          'split',
          'atIndex',
          'extractRegex',
          'add',
          'subtract',
          'multiply',
          'divide',
          'modulo',
          'datePart',
          'substring',
          'replace',
          'replaceRegex',
          'dateDiff',
          'dateAdd',
          'concat',
          'coalesce',
        ],
      },
      columnId: {
        type: 'string',
      },
      value: buildScalarSchema(),
      input: buildLooseObjectSchema(),
      left: buildLooseObjectSchema(),
      right: buildLooseObjectSchema(),
      first: buildLooseObjectSchema(),
      second: buildLooseObjectSchema(),
      third: buildLooseObjectSchema(),
      items: buildLooseObjectArraySchema(),
      subject: buildLooseObjectSchema(),
      cases: buildLooseObjectArraySchema(),
      then: buildLooseObjectSchema(),
      when: buildLooseObjectSchema(),
    },
  };
}

function buildAuthoringBooleanExpressionSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      kind: {
        type: 'string',
        enum: ['predicate', 'compare', 'between', 'boolean'],
      },
      op: {
        type: 'string',
        enum: ['isEmpty', 'eq', 'gt', 'lt', 'gte', 'lte', 'contains', 'startsWith', 'endsWith', 'matchesRegex', 'and', 'or', 'not'],
      },
      input: buildLooseObjectSchema(),
      left: buildLooseObjectSchema(),
      right: buildLooseObjectSchema(),
      min: buildLooseObjectSchema(),
      max: buildLooseObjectSchema(),
      inclusiveMin: {
        type: 'boolean',
      },
      inclusiveMax: {
        type: 'boolean',
      },
      items: buildLooseObjectArraySchema(),
      item: buildLooseObjectSchema(),
    },
    required: ['kind'],
  };
}

function buildLooseObjectSchema() {
  return {
    type: 'object',
    additionalProperties: true,
  };
}

function buildLooseObjectArraySchema() {
  return {
    type: 'array',
    items: buildLooseObjectSchema(),
  };
}

function buildStringArraySchema() {
  return {
    type: 'array',
    items: {
      type: 'string',
    },
  };
}

function buildScalarSchema() {
  return {
    type: ['string', 'number', 'boolean', 'null'],
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
