import type { WorkflowValidationIssue } from '../workflow';

import { appendDraftStepsToWorkflow, assignWorkflowStepIds } from './draft';
import { generateGeminiDraftTurn } from './gemini';
import { buildRepairUserMessage } from './prompt';
import type {
  AIProgressEvent,
  AIDebugTrace,
  AIDraft,
  AIMessage,
  GeminiClientLogEvent,
  GeminiWorkflowResponse,
  WorkflowStepInput,
  AISettings,
  AIPromptContext,
} from './types';

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
      response: GeminiWorkflowResponse;
      repaired: false;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'draft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: GeminiWorkflowResponse;
      repaired: boolean;
      draft: AIDraft;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'invalidDraft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: GeminiWorkflowResponse;
      repaired: boolean;
      validationIssues: WorkflowValidationIssue[];
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
      assistantMessage: createMessage('assistant', initialTurn.response.assistantMessage),
      response: initialTurn.response,
      repaired: false,
      debugTrace: {
        outcomeKind: 'clarify',
        repaired: false,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: [],
        repairValidationIssues: [],
      },
    };
  }

  emitProgress(options, 'validate_initial', 'Validating initial draft against the current workflow and schema.');
  const initialValidation = await validateDraftResponse(
    options.context,
    initialTurn.response.steps ?? [],
    options.validateCandidateWorkflow,
  );

  if (initialValidation.issues.length === 0) {
    emitProgress(options, 'complete', 'Initial AI draft validated successfully.');
    return {
      kind: 'draft',
      userMessage,
      assistantMessage: createMessage('assistant', initialTurn.response.assistantMessage),
      response: initialTurn.response,
      repaired: false,
      debugTrace: {
        outcomeKind: 'draft',
        repaired: false,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: [],
        repairValidationIssues: [],
      },
      draft: {
        steps: initialValidation.steps,
        assumptions: initialTurn.response.assumptions,
        assistantMessage: initialTurn.response.assistantMessage,
        validationIssues: [],
      },
    };
  }

  emitProgress(options, 'repair_requested', `Initial draft failed validation with ${initialValidation.issues.length} issue${initialValidation.issues.length === 1 ? '' : 's'}. Requesting one repair.`);
  const repairUserMessage = createMessage(
    'user',
    buildRepairUserMessage(
      initialTurn.rawText,
      initialValidation.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
        stepId: issue.stepId,
      })),
    ),
  );
  emitProgress(options, 'request_repair', 'Sending repair request to Gemini.');
  const repairTurn = await generateGeminiDraftTurn(
    {
      settings: options.settings,
      context: {
        ...options.context,
        messages: [
          ...options.context.messages,
          userMessage,
          createMessage('assistant', initialTurn.rawText),
        ],
      },
      userMessage: repairUserMessage,
      phase: 'repair',
      onLogEvent: options.onGeminiLogEvent,
    },
    options.fetchFn,
  );
  emitProgress(options, 'response_repair', `Received repair response in mode "${repairTurn.response.mode}".`);

  if (repairTurn.response.mode !== 'draft') {
    emitProgress(options, 'complete', 'Repair response did not return a draft.');
    return {
      kind: 'invalidDraft',
      userMessage,
      assistantMessage: createMessage('assistant', repairTurn.response.assistantMessage),
      response: repairTurn.response,
      repaired: true,
      validationIssues: initialValidation.issues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: initialValidation.issues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        repairValidationIssues: [],
      },
    };
  }

  emitProgress(options, 'validate_repair', 'Validating repaired draft.');
  const repairedValidation = await validateDraftResponse(
    options.context,
    repairTurn.response.steps ?? [],
    options.validateCandidateWorkflow,
  );

  if (repairedValidation.issues.length > 0) {
    emitProgress(options, 'complete', `Repaired draft still failed validation with ${repairedValidation.issues.length} issue${repairedValidation.issues.length === 1 ? '' : 's'}.`);
    return {
      kind: 'invalidDraft',
      userMessage,
      assistantMessage: createMessage('assistant', repairTurn.response.assistantMessage),
      response: repairTurn.response,
      repaired: true,
      validationIssues: repairedValidation.issues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: initialValidation.issues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        repairValidationIssues: repairedValidation.issues,
      },
    };
  }

  emitProgress(options, 'complete', 'Repaired draft validated successfully.');
  return {
    kind: 'draft',
    userMessage,
    assistantMessage: createMessage('assistant', repairTurn.response.assistantMessage),
      response: repairTurn.response,
      repaired: true,
      debugTrace: {
        outcomeKind: 'draft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: initialValidation.issues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        repairValidationIssues: [],
      },
      draft: {
        steps: repairedValidation.steps,
      assumptions: repairTurn.response.assumptions,
      assistantMessage: repairTurn.response.assistantMessage,
      validationIssues: [],
    },
  };
}

async function validateDraftResponse(
  context: AIPromptContext,
  stepInputs: WorkflowStepInput[],
  validateCandidateWorkflow: (workflow: AIPromptContext['workflow']) => Promise<WorkflowValidationIssue[]>,
) {
  if (stepInputs.length === 0) {
    return {
      steps: [],
      issues: [
        {
          code: 'emptyDraft',
          severity: 'error' as const,
          message: 'AI draft responses must include at least one workflow step.',
          path: 'steps',
          phase: 'semantic' as const,
        },
      ],
    };
  }

  const steps = assignWorkflowStepIds(context.workflow, stepInputs);
  const candidateWorkflow = appendDraftStepsToWorkflow(context.workflow, steps);
  const issues = await validateCandidateWorkflow(candidateWorkflow);

  return {
    steps,
    issues,
  };
}

function createMessage(role: AIMessage['role'], text: string): AIMessage {
  return {
    role,
    text,
    timestamp: new Date().toISOString(),
  };
}

function emitProgress(options: RunGeminiDraftTurnOptions, stage: AIProgressEvent['stage'], message: string) {
  options.onProgress?.({
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}
