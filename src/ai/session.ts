import type { WorkflowValidationIssue } from '../workflow';

import { assignWorkflowStepIds, replaceWorkflowSteps } from './draft';
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
  const initialRelevantIssues = selectRelevantValidationIssues(initialValidation.issues);

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

  emitProgress(
    options,
    'repair_requested',
    `Initial draft failed validation with ${formatIssueSummary(initialValidation.issues.length, initialRelevantIssues.length)}. Requesting one repair.`,
  );
  const repairUserMessage = createMessage(
    'user',
    buildRepairUserMessage(
      initialTurn.rawText,
      initialRelevantIssues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
        stepId: issue.stepId,
      })),
      options.context,
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
      validationIssues: initialRelevantIssues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: initialRelevantIssues,
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
  const repairRelevantIssues = selectRelevantValidationIssues(repairedValidation.issues);

  if (repairedValidation.issues.length > 0) {
    emitProgress(
      options,
      'complete',
      `Repaired draft still failed validation with ${formatIssueSummary(repairedValidation.issues.length, repairRelevantIssues.length)}.`,
    );
    return {
      kind: 'invalidDraft',
      userMessage,
      assistantMessage: createMessage('assistant', repairTurn.response.assistantMessage),
      response: repairTurn.response,
      repaired: true,
      validationIssues: repairRelevantIssues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialValidationIssues: initialRelevantIssues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        repairValidationIssues: repairRelevantIssues,
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
        initialValidationIssues: initialRelevantIssues,
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

  const steps = assignWorkflowStepIds(stepInputs);
  const candidateWorkflow = replaceWorkflowSteps(context.workflow, steps);
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

function selectRelevantValidationIssues(issues: WorkflowValidationIssue[], limit = 12) {
  if (issues.length <= 1) {
    return issues;
  }

  const structuralIssues = issues.filter((issue) => issue.phase === 'structural');
  const sourceIssues = structuralIssues.length > 0 ? structuralIssues : issues;
  const dedupedIssues = dedupeIssues(sourceIssues);
  const rankedIssues = [...dedupedIssues].sort((left, right) => compareIssues(left, right, structuralIssues.length > 0));
  const selectedIssues: WorkflowValidationIssue[] = [];

  for (const issue of rankedIssues) {
    if (issue.phase === 'structural' && issue.code === 'schema.oneOf' && issue.path === '$' && rankedIssues.some((candidate) => candidate.path !== '$')) {
      continue;
    }

    if (issue.phase === 'structural' && issue.code === 'schema.oneOf' && rankedIssues.some((candidate) => candidate !== issue && isSameOrDescendantPath(candidate.path, issue.path))) {
      continue;
    }

    if (selectedIssues.some((selected) => isSameOrDescendantPath(issue.path, selected.path))) {
      continue;
    }

    selectedIssues.push(issue);

    if (selectedIssues.length >= limit) {
      break;
    }
  }

  return selectedIssues.length > 0 ? selectedIssues : dedupedIssues.slice(0, Math.min(limit, dedupedIssues.length));
}

function dedupeIssues(issues: WorkflowValidationIssue[]) {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.phase}|${issue.code}|${issue.path}|${issue.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function compareIssues(left: WorkflowValidationIssue, right: WorkflowValidationIssue, structuralOnly: boolean) {
  const leftPriority = getIssuePriority(left, structuralOnly);
  const rightPriority = getIssuePriority(right, structuralOnly);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  if (left.path.length !== right.path.length) {
    return left.path.length - right.path.length;
  }

  return left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}

function getIssuePriority(issue: WorkflowValidationIssue, structuralOnly: boolean) {
  if (structuralOnly) {
    switch (issue.code) {
      case 'schema.type':
        return 0;
      case 'schema.required':
        return 1;
      case 'schema.enum':
        return 2;
      case 'schema.additionalProperties':
        return 3;
      case 'schema.const':
        return 4;
      case 'schema.pattern':
        return 5;
      case 'schema.maxItems':
      case 'schema.minItems':
        return 6;
      case 'schema.oneOf':
        return 9;
      default:
        return 8;
    }
  }

  switch (issue.code) {
    case 'missingColumn':
      return 0;
    case 'invalidExpression':
      return 1;
    case 'incompatibleType':
      return 2;
    case 'invalidRegex':
      return 3;
    case 'duplicateColumnReference':
      return 4;
    default:
      return 5;
  }
}

function isSameOrDescendantPath(path: string, ancestorPath: string) {
  if (path === ancestorPath) {
    return true;
  }

  if (ancestorPath === '$') {
    return false;
  }

  return path.startsWith(`${ancestorPath}.`) || path.startsWith(`${ancestorPath}[`);
}

function formatIssueSummary(totalCount: number, relevantCount: number) {
  const totalLabel = `${totalCount} issue${totalCount === 1 ? '' : 's'}`;

  if (relevantCount === totalCount) {
    return totalLabel;
  }

  return `${totalLabel}; using ${relevantCount} relevant issue${relevantCount === 1 ? '' : 's'}`;
}

function emitProgress(options: RunGeminiDraftTurnOptions, stage: AIProgressEvent['stage'], message: string) {
  options.onProgress?.({
    stage,
    message,
    timestamp: new Date().toISOString(),
  });
}
