import type { WorkflowValidationIssue } from '../workflow';

import { mapWorkflowValidationIssueToAIDraftIssue } from './compileAuthoringDraft';
import type { AuthoringDraftResponse } from './authoringIr';
import { assignWorkflowStepIds, replaceWorkflowSteps } from './draft';
import { evaluateDraftQuality } from './evaluateDraftQuality';
import { generateGeminiDraftTurn } from './gemini';
import { buildRepairUserMessage } from './prompt';
import { selectRelevantValidationIssues as selectRelevantRepairValidationIssues, selectRepairPromptIssues } from './repairIssues';
import type { AIDraftIssue } from './authoringIr';
import type {
  AIDebugRepairAttempt,
  AIProgressEvent,
  AIDebugTrace,
  AIDraft,
  AIMessage,
  GeminiClientLogEvent,
  GeminiDraftTurnResult,
  WorkflowStepInput,
  AISettings,
  AIPromptContext,
} from './types';

const MAX_REPAIR_ATTEMPTS = 2;

export interface RunGeminiDraftTurnOptions {
  settings: AISettings;
  context: AIPromptContext;
  userText: string;
  validateCandidateWorkflow: (workflow: AIPromptContext['workflow']) => Promise<WorkflowValidationIssue[]>;
  fetchFn?: typeof fetch;
  onProgress?: (event: AIProgressEvent) => void;
  onGeminiLogEvent?: (event: GeminiClientLogEvent) => void;
}

export type GeminiDraftTurnOutcome =
  | {
      kind: 'clarify';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: AuthoringDraftResponse;
      repaired: false;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'draft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: AuthoringDraftResponse;
      repaired: boolean;
      draft: AIDraft;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'invalidDraft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: AuthoringDraftResponse;
      repaired: boolean;
      validationIssues: AIDraftIssue[];
      debugTrace: AIDebugTrace;
    };

export async function runGeminiDraftTurn(options: RunGeminiDraftTurnOptions): Promise<GeminiDraftTurnOutcome> {
  const userMessage = createMessage('user', options.userText);

  emitProgress(options, 'start', 'Starting AI draft turn.');

  emitProgress(options, 'request_initial', 'Sending initial Gemini request.');
  const initialTurn = await generateGeminiDraftTurn(
    {
      settings: options.settings,
      context: options.context,
      userMessage,
      phase: 'initial',
      onLogEvent: options.onGeminiLogEvent,
    },
    options.fetchFn,
  );
  emitProgress(options, 'response_initial', `Received initial Gemini response in mode "${initialTurn.response.mode}".`);

  if (initialTurn.response.mode === 'clarify') {
    emitProgress(options, 'complete', 'AI turn completed with a clarification question.');
    return {
      kind: 'clarify',
      userMessage,
      assistantMessage: createMessage('assistant', initialTurn.response.msg),
      response: initialTurn.response,
      repaired: false,
      debugTrace: {
        outcomeKind: 'clarify',
        repaired: false,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialCompilationIssues: [],
        initialValidationIssues: [],
        repairAttempts: [],
      },
    };
  }

  emitProgress(options, 'validate_initial', 'Compiling and validating the initial AI draft.');
  const initialValidation = await validateDraftResponse(
    options.context,
    options.userText,
    initialTurn.compilationIssues,
    initialTurn.compiledSteps,
    options.validateCandidateWorkflow,
  );
  const initialRelevantIssues = selectRelevantRepairValidationIssues(initialValidation.issues);

  if (initialValidation.issues.length === 0) {
    emitProgress(options, 'complete', 'Initial AI draft validated successfully.');
    return {
      kind: 'draft',
      userMessage,
      assistantMessage: createMessage('assistant', initialTurn.response.msg),
      response: initialTurn.response,
      repaired: false,
      debugTrace: {
        outcomeKind: 'draft',
        repaired: false,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        ...(initialTurn.compiledSteps ? { initialCompiledSteps: initialTurn.compiledSteps } : {}),
        initialCompilationIssues: initialTurn.compilationIssues,
        initialValidationIssues: [],
        repairAttempts: [],
      },
      draft: {
        steps: initialValidation.steps,
        assumptions: initialTurn.response.ass,
        assistantMessage: initialTurn.response.msg,
        validationIssues: [],
      },
    };
  }

  const repairAttempts: AIDebugRepairAttempt[] = [];
  let previousRawText = initialTurn.rawText;
  let previousResponse = initialTurn.response;
  let previousValidation = initialValidation;
  let previousRelevantIssues = initialRelevantIssues;
  let repairMessages = [
    ...options.context.messages,
    userMessage,
    createMessage('assistant', initialTurn.rawText),
  ];

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    const repairPromptIssues = selectRepairPromptIssues(previousValidation.issues, previousValidation.steps);

    emitProgress(
      options,
      'repair_requested',
      `${attempt === 1 ? 'Initial draft' : `Repair ${attempt - 1}`} failed validation with ${formatIssueSummary(previousValidation.issues.length, repairPromptIssues.length)}. Requesting repair ${attempt} of ${MAX_REPAIR_ATTEMPTS}.`,
      attempt,
    );

    const repairUserMessage = createMessage(
      'user',
      buildRepairUserMessage(previousRawText, repairPromptIssues, options.context),
    );

    emitProgress(options, 'request_repair', `Sending repair request ${attempt} of ${MAX_REPAIR_ATTEMPTS} to Gemini.`, attempt);
    const repairTurn = await generateGeminiDraftTurn(
      {
        settings: options.settings,
        context: {
          ...options.context,
          messages: repairMessages,
        },
        userMessage: repairUserMessage,
        phase: 'repair',
        onLogEvent: options.onGeminiLogEvent,
      },
      options.fetchFn,
    );
    emitProgress(options, 'response_repair', `Received repair response ${attempt} of ${MAX_REPAIR_ATTEMPTS} in mode "${repairTurn.response.mode}".`, attempt);

    if (repairTurn.response.mode !== 'draft') {
      repairAttempts.push({
        attempt,
        repairPromptIssues,
        rawText: repairTurn.rawText,
        response: repairTurn.response,
        ...(repairTurn.compiledSteps ? { compiledSteps: repairTurn.compiledSteps } : {}),
        compilationIssues: repairTurn.compilationIssues,
        validationIssues: [],
      });

      previousRawText = repairTurn.rawText;
      previousResponse = repairTurn.response;
      repairMessages = [
        ...repairMessages,
        repairUserMessage,
        createMessage('assistant', repairTurn.rawText),
      ];

      if (attempt < MAX_REPAIR_ATTEMPTS) {
        continue;
      }

      emitProgress(options, 'complete', 'Final repair response did not return a draft.');
      return {
        kind: 'invalidDraft',
        userMessage,
        assistantMessage: createMessage('assistant', previousResponse.msg),
        response: previousResponse,
        repaired: true,
        validationIssues: previousRelevantIssues,
        debugTrace: buildDebugTrace({
          outcomeKind: 'invalidDraft',
          repaired: true,
          initialTurn,
          initialValidationIssues: initialRelevantIssues,
          repairAttempts,
        }),
      };
    }

    emitProgress(options, 'validate_repair', `Compiling and validating repaired draft ${attempt} of ${MAX_REPAIR_ATTEMPTS}.`, attempt);
    const repairedValidation = await validateDraftResponse(
      options.context,
      options.userText,
      repairTurn.compilationIssues,
      repairTurn.compiledSteps,
      options.validateCandidateWorkflow,
    );
    const repairRelevantIssues = selectRelevantRepairValidationIssues(repairedValidation.issues);

    repairAttempts.push({
      attempt,
      repairPromptIssues,
      rawText: repairTurn.rawText,
      response: repairTurn.response,
      ...(repairTurn.compiledSteps ? { compiledSteps: repairTurn.compiledSteps } : {}),
      compilationIssues: repairTurn.compilationIssues,
      validationIssues: repairRelevantIssues,
    });

    if (repairedValidation.issues.length === 0) {
      emitProgress(options, 'complete', `Repair ${attempt} validated successfully.`);
      return {
        kind: 'draft',
        userMessage,
        assistantMessage: createMessage('assistant', repairTurn.response.msg),
        response: repairTurn.response,
        repaired: true,
        debugTrace: buildDebugTrace({
          outcomeKind: 'draft',
          repaired: true,
          initialTurn,
          initialValidationIssues: initialRelevantIssues,
          repairAttempts,
        }),
        draft: {
          steps: repairedValidation.steps,
          assumptions: repairTurn.response.ass,
          assistantMessage: repairTurn.response.msg,
          validationIssues: [],
        },
      };
    }

    previousRawText = repairTurn.rawText;
    previousResponse = repairTurn.response;
    previousValidation = repairedValidation;
    previousRelevantIssues = repairRelevantIssues;
    repairMessages = [
      ...repairMessages,
      repairUserMessage,
      createMessage('assistant', repairTurn.rawText),
    ];
  }

  emitProgress(
    options,
    'complete',
    `Final repaired draft still failed validation with ${formatIssueSummary(previousValidation.issues.length, previousRelevantIssues.length)}.`,
  );

  return {
    kind: 'invalidDraft',
    userMessage,
    assistantMessage: createMessage('assistant', previousResponse.msg),
    response: previousResponse,
    repaired: true,
    validationIssues: previousRelevantIssues,
    debugTrace: buildDebugTrace({
      outcomeKind: 'invalidDraft',
      repaired: true,
      initialTurn,
      initialValidationIssues: initialRelevantIssues,
      repairAttempts,
    }),
  };
}

function buildDebugTrace(input: {
  outcomeKind: AIDebugTrace['outcomeKind'];
  repaired: boolean;
  initialTurn: GeminiDraftTurnResult;
  initialValidationIssues: AIDraftIssue[];
  repairAttempts: AIDebugRepairAttempt[];
}): AIDebugTrace {
  return {
    outcomeKind: input.outcomeKind,
    repaired: input.repaired,
    initialRawText: input.initialTurn.rawText,
    initialResponse: input.initialTurn.response,
    ...(input.initialTurn.compiledSteps ? { initialCompiledSteps: input.initialTurn.compiledSteps } : {}),
    initialCompilationIssues: input.initialTurn.compilationIssues,
    initialValidationIssues: input.initialValidationIssues,
    repairAttempts: input.repairAttempts,
  };
}

async function validateDraftResponse(
  context: AIPromptContext,
  userText: string,
  compilationIssues: AIDraftIssue[],
  compiledStepInputs: WorkflowStepInput[] | undefined,
  validateCandidateWorkflow: (workflow: AIPromptContext['workflow']) => Promise<WorkflowValidationIssue[]>,
): Promise<{ steps: ReturnType<typeof assignWorkflowStepIds>; issues: AIDraftIssue[] }> {
  if (compilationIssues.length > 0 || !compiledStepInputs) {
    return {
      steps: [],
      issues: compilationIssues,
    };
  }

  if (compiledStepInputs.length === 0) {
    return {
      steps: [],
      issues: [
        {
          code: 'emptyDraft',
          severity: 'error',
          message: 'AI draft responses must include at least one workflow step.',
          path: 'steps',
          phase: 'authoring',
        },
      ],
    };
  }

  const steps = assignWorkflowStepIds(compiledStepInputs);
  const candidateWorkflow = replaceWorkflowSteps(context.workflow, steps);
  const issues = (await validateCandidateWorkflow(candidateWorkflow)).map(mapWorkflowValidationIssueToAIDraftIssue);
  const qualityIssues = evaluateDraftQuality({
    context,
    userText,
    steps,
  });

  return {
    steps,
    issues: [...issues, ...qualityIssues],
  };
}

function createMessage(role: AIMessage['role'], text: string): AIMessage {
  return {
    role,
    text,
    timestamp: new Date().toISOString(),
  };
}

function formatIssueSummary(totalCount: number, relevantCount: number) {
  const totalLabel = `${totalCount} issue${totalCount === 1 ? '' : 's'}`;

  if (relevantCount === totalCount) {
    return totalLabel;
  }

  return `${totalLabel}; using ${relevantCount} relevant issue${relevantCount === 1 ? '' : 's'}`;
}

function emitProgress(options: RunGeminiDraftTurnOptions, stage: AIProgressEvent['stage'], message: string, attempt?: number) {
  options.onProgress?.({
    stage,
    message,
    timestamp: new Date().toISOString(),
    ...(typeof attempt === 'number' ? { attempt } : {}),
  });
}
