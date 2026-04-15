import { compileAuthoringResponse } from './compileAuthoringDraft';
import { type AuthoringDraftResponse } from './authoringIr';
import {
  buildChecklistVerificationSystemInstruction,
  buildChecklistVerificationUserMessage,
  buildGeminiContents,
  buildGeminiSystemInstruction,
  buildRequirementPlanSystemInstruction,
  type GeminiPromptOptions,
} from './prompt';
import type {
  AIChecklistVerificationResponse,
  AIRequirementPlanResponse,
  GeminiClientLogEvent,
  GeminiDraftTurnInput,
  GeminiDraftTurnResult,
  AISettings,
  AIPromptContext,
  AIMessage,
  AIDraft,
} from './types';

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
const GEMINI_REQUEST_TIMEOUT_MS = 180_000;
export const GEMINI_MAX_OUTPUT_TOKENS = 16_384;

interface BuildGeminiRequestExportOptions {
  responseJsonSchema?: GeminiResponseJsonSchema;
  promptOptions?: GeminiPromptOptions;
}

export interface GeminiRequestExport {
  exportedAt: string;
  phase: GeminiClientLogEvent['phase'];
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
      responseMimeType?: 'application/json';
      responseJsonSchema?: GeminiResponseJsonSchema;
      temperature: number;
      maxOutputTokens: number;
      thinkingConfig?: GeminiThinkingConfig;
    };
  };
}

export interface GeminiRequirementPlanTurnInput {
  settings: AISettings;
  context: AIPromptContext;
  userMessage: AIMessage;
  onLogEvent?: (event: GeminiClientLogEvent) => void;
}

export interface GeminiRequirementPlanTurnResult {
  response: AIRequirementPlanResponse;
  rawText: string;
}

export interface GeminiChecklistVerificationTurnInput {
  settings: AISettings;
  context: AIPromptContext;
  userMessage: AIMessage;
  requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>;
  draft: AIDraft;
  onLogEvent?: (event: GeminiClientLogEvent) => void;
}

export interface GeminiChecklistVerificationTurnResult {
  response: AIChecklistVerificationResponse;
  rawText: string;
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
      ...(input.promptOptions ? { promptOptions: input.promptOptions } : {}),
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

    if (parsed.mode === 'clarify') {
      return {
        response: parsed,
        rawText,
        compilationIssues: [],
      };
    }

    const compiled = compileAuthoringResponse(parsed);

    return {
      response: parsed,
      rawText,
      ...(compiled.value ? { compiledDraft: compiled.value } : {}),
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

export async function generateGeminiRequirementPlanTurn(
  input: GeminiRequirementPlanTurnInput,
  fetchFn: typeof fetch = fetch,
): Promise<GeminiRequirementPlanTurnResult> {
  const rawText = await requestGeminiText(
    {
      settings: input.settings,
      phase: 'plan',
      systemInstructionText: buildRequirementPlanSystemInstruction(input.context),
      contents: buildGeminiContents(input.context.messages, input.userMessage),
      onLogEvent: input.onLogEvent,
    },
    fetchFn,
  );
  const parsed = parseGeminiRequirementPlanResponse(rawText);

  emitGenericLogEvent(input.onLogEvent, 'plan', 'response_parsed', `Gemini requirement plan parsed in mode "${parsed.mode}".`, {
    rawText,
  });

  return {
    response: parsed,
    rawText,
  };
}

export async function generateGeminiChecklistVerificationTurn(
  input: GeminiChecklistVerificationTurnInput,
  fetchFn: typeof fetch = fetch,
): Promise<GeminiChecklistVerificationTurnResult> {
  const rawText = await requestGeminiText(
    {
      settings: input.settings,
      phase: 'verify',
      systemInstructionText: buildChecklistVerificationSystemInstruction(input.context),
      contents: buildGeminiContents(input.context.messages, {
        ...input.userMessage,
        text: buildChecklistVerificationUserMessage({
          userText: input.userMessage.text,
          requirementPlan: input.requirementPlan,
          draft: input.draft,
        }),
      }),
      onLogEvent: input.onLogEvent,
    },
    fetchFn,
  );
  const parsed = parseGeminiChecklistVerificationResponse(rawText);

  emitGenericLogEvent(input.onLogEvent, 'verify', 'response_parsed', `Gemini checklist verification parsed with status "${parsed.status}".`, {
    rawText,
  });

  return {
    response: parsed,
    rawText,
  };
}

export function buildGeminiRequestExport(
  input: GeminiDraftTurnInput,
  options: BuildGeminiRequestExportOptions = {},
): GeminiRequestExport {
  const systemInstructionText = buildGeminiSystemInstruction(input.context, options.promptOptions);
  const contents = buildGeminiContents(input.context.messages, input.userMessage);
  const normalizedModel = normalizeGeminiModel(input.settings.model);
  const thinkingConfig = buildThinkingConfig(normalizedModel, input.settings.thinkingEnabled);
  const generationConfig = {
    ...(options.responseJsonSchema
      ? {
          responseMimeType: 'application/json' as const,
          responseJsonSchema: options.responseJsonSchema,
        }
      : {}),
    temperature: 0,
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

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
      generationConfig,
    },
  };
}

function buildGenericGeminiRequestExport(input: {
  settings: AISettings;
  phase: GeminiClientLogEvent['phase'];
  systemInstructionText: string;
  contents: ReturnType<typeof buildGeminiContents>;
}): GeminiRequestExport {
  const normalizedModel = normalizeGeminiModel(input.settings.model);
  const thinkingConfig = buildThinkingConfig(normalizedModel, input.settings.thinkingEnabled);
  const generationConfig = {
    temperature: 0,
    maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

  return {
    exportedAt: new Date().toISOString(),
    phase: input.phase,
    model: normalizedModel,
    requestUrl: buildGeminiUrl(normalizedModel),
    systemInstructionText: input.systemInstructionText,
    contents: input.contents,
    requestBody: {
      systemInstruction: {
        parts: [{ text: input.systemInstructionText }],
      },
      contents: input.contents,
      generationConfig,
    },
  };
}

async function requestGeminiText(
  input: {
    settings: AISettings;
    phase: GeminiClientLogEvent['phase'];
    systemInstructionText: string;
    contents: ReturnType<typeof buildGeminiContents>;
    onLogEvent?: (event: GeminiClientLogEvent) => void;
  },
  fetchFn: typeof fetch,
) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, GEMINI_REQUEST_TIMEOUT_MS);

  try {
    const requestExport = buildGenericGeminiRequestExport(input);
    const loggedRequestExport = requestExport as unknown as Record<string, unknown>;

    emitGenericLogEvent(input.onLogEvent, input.phase, 'request_started', 'Gemini request started.', {
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
    emitGenericLogEvent(input.onLogEvent, input.phase, 'response_received', 'Gemini response body received.', {
      rawText,
    });

    return rawText;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timeoutMessage = `Gemini request timed out after ${Math.floor(GEMINI_REQUEST_TIMEOUT_MS / 1000)} seconds.`;

      emitGenericLogEvent(input.onLogEvent, input.phase, 'request_failed', timeoutMessage, {
        error: timeoutMessage,
      });
      throw new Error(timeoutMessage);
    }

    emitGenericLogEvent(input.onLogEvent, input.phase, 'request_failed', error instanceof Error ? error.message : 'Gemini request failed.', {
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

export function parseGeminiAuthoringResponse(rawText: string): AuthoringDraftResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini returned an invalid authoring response.');
  }

  const mode = parsed.mode;
  const msg = parsed.msg;
  const ass = parsed.ass;

  if (mode !== 'clarify' && mode !== 'draft' && mode !== 'workflowSetDraft') {
    throw new Error('Gemini response must include mode "clarify", "draft", or "workflowSetDraft".');
  }

  if (typeof msg !== 'string' || msg.trim() === '') {
    throw new Error('Gemini response must include a non-empty msg string.');
  }

  if (!Array.isArray(ass) || ass.some((value) => typeof value !== 'string')) {
    throw new Error('Gemini response must include ass as a string array.');
  }

  if (mode === 'workflowSetDraft') {
    const applyMode = parsed.applyMode;
    const workflows = parsed.workflows;
    const runOrderWorkflowIds = parsed.runOrderWorkflowIds;

    if (applyMode !== 'append' && applyMode !== 'replaceActive' && applyMode !== 'replacePackage') {
      throw new Error('Gemini workflowSetDraft responses must include applyMode "append", "replaceActive", or "replacePackage".');
    }

    if (!Array.isArray(workflows) || workflows.length === 0 || workflows.some((workflow) => !workflow || typeof workflow !== 'object' || Array.isArray(workflow))) {
      throw new Error('Gemini workflowSetDraft responses must include a non-empty workflows object array.');
    }

    if (!Array.isArray(runOrderWorkflowIds) || runOrderWorkflowIds.some((workflowId) => typeof workflowId !== 'string')) {
      throw new Error('Gemini workflowSetDraft responses must include runOrderWorkflowIds as a string array.');
    }

    return {
      mode,
      msg,
      ass,
      applyMode,
      workflows: workflows as Extract<AuthoringDraftResponse, { mode: 'workflowSetDraft' }>['workflows'],
      runOrderWorkflowIds: runOrderWorkflowIds as string[],
    };
  }

  const steps = parsed.steps;

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
    steps: steps as Extract<AuthoringDraftResponse, { mode: 'draft' | 'clarify' }>['steps'],
  };
}

export function parseGeminiRequirementPlanResponse(rawText: string): AIRequirementPlanResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini returned an invalid requirement plan response.');
  }

  const mode = parsed.mode;
  const msg = parsed.msg;
  const ass = parsed.ass;

  if (mode !== 'clarify' && mode !== 'plan') {
    throw new Error('Gemini requirement plan response must include mode "clarify" or "plan".');
  }

  if (typeof msg !== 'string' || msg.trim() === '') {
    throw new Error('Gemini requirement plan response must include a non-empty msg string.');
  }

  if (!Array.isArray(ass) || ass.some((value) => typeof value !== 'string')) {
    throw new Error('Gemini requirement plan response must include ass as a string array.');
  }

  if (mode === 'clarify') {
    return {
      mode,
      msg,
      ass,
    };
  }

  const draftKind = parsed.draftKind;
  const checklist = parsed.checklist;

  if (draftKind !== 'singleWorkflow' && draftKind !== 'workflowSet') {
    throw new Error('Gemini requirement plan responses must include draftKind "singleWorkflow" or "workflowSet".');
  }

  if (!Array.isArray(checklist) || checklist.length === 0 || checklist.some((item) => !isRequirementChecklistItem(item))) {
    throw new Error('Gemini requirement plan responses must include a non-empty checklist array.');
  }

  return {
    mode,
    msg,
    ass,
    draftKind,
    checklist: checklist.map((item) => ({
      id: (item as { id: string }).id,
      requirement: (item as { requirement: string }).requirement,
      acceptanceCriteria: [...(item as { acceptanceCriteria: string[] }).acceptanceCriteria],
    })),
    ...(isWorkflowPlan(parsed.workflowPlan) ? { workflowPlan: parsed.workflowPlan } : {}),
  };
}

export function parseGeminiChecklistVerificationResponse(rawText: string): AIChecklistVerificationResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Gemini returned an invalid checklist verification response.');
  }

  const status = parsed.status;
  const issues = parsed.issues;

  if (status !== 'pass' && status !== 'fail') {
    throw new Error('Gemini checklist verification response must include status "pass" or "fail".');
  }

  if (!Array.isArray(issues) || issues.some((issue) => !isChecklistVerificationIssue(issue))) {
    throw new Error('Gemini checklist verification response must include issues as an object array.');
  }

  return {
    status,
    issues: issues.map((issue) => ({
      checklistId: (issue as { checklistId: string }).checklistId,
      code: (issue as { code: string }).code,
      message: (issue as { message: string }).message,
    })),
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

function isRequirementChecklistItem(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string'
    && candidate.id.trim() !== ''
    && typeof candidate.requirement === 'string'
    && candidate.requirement.trim() !== ''
    && Array.isArray(candidate.acceptanceCriteria)
    && candidate.acceptanceCriteria.length > 0
    && candidate.acceptanceCriteria.every((criterion) => typeof criterion === 'string' && criterion.trim() !== '');
}

function isWorkflowPlan(value: unknown): value is Extract<AIRequirementPlanResponse, { mode: 'plan' }>['workflowPlan'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (
    candidate.applyMode !== undefined
    && candidate.applyMode !== 'append'
    && candidate.applyMode !== 'replaceActive'
    && candidate.applyMode !== 'replacePackage'
  ) {
    return false;
  }

  if (
    candidate.workflows !== undefined
    && (!Array.isArray(candidate.workflows)
      || candidate.workflows.some((workflow) => !workflow
        || typeof workflow !== 'object'
        || Array.isArray(workflow)
        || typeof (workflow as Record<string, unknown>).workflowId !== 'string'
        || typeof (workflow as Record<string, unknown>).name !== 'string'
        || ((workflow as Record<string, unknown>).description !== undefined && typeof (workflow as Record<string, unknown>).description !== 'string')))
  ) {
    return false;
  }

  if (
    candidate.runOrderWorkflowIds !== undefined
    && (!Array.isArray(candidate.runOrderWorkflowIds) || candidate.runOrderWorkflowIds.some((workflowId) => typeof workflowId !== 'string'))
  ) {
    return false;
  }

  return true;
}

function isChecklistVerificationIssue(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.checklistId === 'string'
    && candidate.checklistId.trim() !== ''
    && typeof candidate.code === 'string'
    && candidate.code.trim() !== ''
    && typeof candidate.message === 'string'
    && candidate.message.trim() !== '';
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

function emitGenericLogEvent(
  onLogEvent: ((event: GeminiClientLogEvent) => void) | undefined,
  phase: GeminiClientLogEvent['phase'],
  kind: GeminiClientLogEvent['kind'],
  message: string,
  extra: Partial<Pick<GeminiClientLogEvent, 'rawText' | 'error' | 'responseMode' | 'requestExport' | 'statusCode' | 'responseBody'>> = {},
) {
  onLogEvent?.({
    phase,
    kind,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  });
}
