import type { WorkflowValidationIssue } from '../workflow';

import { mapWorkflowValidationIssueToAIDraftIssue } from './compileAuthoringDraft';
import type { GeminiCompilerOpsDraftResponse } from './compilerOpsDraft';
import { assignWorkflowStepIds, replaceWorkflowSteps } from './draft';
import { generateGeminiDraftTurn } from './gemini';
import { buildRepairUserMessage } from './prompt';
import type { AIDraftIssue } from './authoringIr';
import type {
  AIProgressEvent,
  AIDebugTrace,
  AIDraft,
  AIMessage,
  GeminiClientLogEvent,
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
      response: GeminiCompilerOpsDraftResponse;
      repaired: false;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'draft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: GeminiCompilerOpsDraftResponse;
      repaired: boolean;
      draft: AIDraft;
      debugTrace: AIDebugTrace;
    }
  | {
      kind: 'invalidDraft';
      userMessage: AIMessage;
      assistantMessage: AIMessage;
      response: GeminiCompilerOpsDraftResponse;
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
        repairCompilationIssues: [],
        repairValidationIssues: [],
      },
    };
  }

  emitProgress(options, 'validate_initial', 'Compiling and validating the initial AI draft.');
  const initialValidation = await validateDraftResponse(
    options.context,
    initialTurn.compilationIssues,
    initialTurn.compiledSteps,
    options.validateCandidateWorkflow,
  );
  const initialRelevantIssues = selectRelevantValidationIssues(initialValidation.issues);

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
        repairCompilationIssues: [],
        repairValidationIssues: [],
      },
      draft: {
        steps: initialValidation.steps,
        assumptions: initialTurn.response.ass,
        assistantMessage: initialTurn.response.msg,
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
      assistantMessage: createMessage('assistant', repairTurn.response.msg),
      response: repairTurn.response,
      repaired: true,
      validationIssues: initialRelevantIssues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        ...(initialTurn.compiledSteps ? { initialCompiledSteps: initialTurn.compiledSteps } : {}),
        initialCompilationIssues: initialTurn.compilationIssues,
        initialValidationIssues: initialRelevantIssues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        ...(repairTurn.compiledSteps ? { repairCompiledSteps: repairTurn.compiledSteps } : {}),
        repairCompilationIssues: repairTurn.compilationIssues,
        repairValidationIssues: [],
      },
    };
  }

  emitProgress(options, 'validate_repair', 'Compiling and validating the repaired draft.');
  const repairedValidation = await validateDraftResponse(
    options.context,
    repairTurn.compilationIssues,
    repairTurn.compiledSteps,
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
      assistantMessage: createMessage('assistant', repairTurn.response.msg),
      response: repairTurn.response,
      repaired: true,
      validationIssues: repairRelevantIssues,
      debugTrace: {
        outcomeKind: 'invalidDraft',
        repaired: true,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        ...(initialTurn.compiledSteps ? { initialCompiledSteps: initialTurn.compiledSteps } : {}),
        initialCompilationIssues: initialTurn.compilationIssues,
        initialValidationIssues: initialRelevantIssues,
        repairRawText: repairTurn.rawText,
        repairResponse: repairTurn.response,
        ...(repairTurn.compiledSteps ? { repairCompiledSteps: repairTurn.compiledSteps } : {}),
        repairCompilationIssues: repairTurn.compilationIssues,
        repairValidationIssues: repairRelevantIssues,
      },
    };
  }

  emitProgress(options, 'complete', 'Repaired draft validated successfully.');
  return {
    kind: 'draft',
    userMessage,
    assistantMessage: createMessage('assistant', repairTurn.response.msg),
    response: repairTurn.response,
    repaired: true,
    debugTrace: {
      outcomeKind: 'draft',
      repaired: true,
      initialRawText: initialTurn.rawText,
      initialResponse: initialTurn.response,
      ...(initialTurn.compiledSteps ? { initialCompiledSteps: initialTurn.compiledSteps } : {}),
      initialCompilationIssues: initialTurn.compilationIssues,
      initialValidationIssues: initialRelevantIssues,
      repairRawText: repairTurn.rawText,
      repairResponse: repairTurn.response,
      ...(repairTurn.compiledSteps ? { repairCompiledSteps: repairTurn.compiledSteps } : {}),
      repairCompilationIssues: repairTurn.compilationIssues,
      repairValidationIssues: [],
    },
    draft: {
      steps: repairedValidation.steps,
      assumptions: repairTurn.response.ass,
      assistantMessage: repairTurn.response.msg,
      validationIssues: [],
    },
  };
}

async function validateDraftResponse(
  context: AIPromptContext,
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

function selectRelevantValidationIssues(issues: AIDraftIssue[], limit = 12) {
  if (issues.length <= 1) {
    return issues;
  }

  const authoringIssues = issues.filter((issue) => issue.phase === 'authoring');
  const structuralIssues = issues.filter((issue) => issue.phase === 'structural');
  const sourceIssues = authoringIssues.length > 0 ? authoringIssues : structuralIssues.length > 0 ? structuralIssues : issues;
  const dedupedIssues = dedupeIssues(sourceIssues);
  const rankedIssues = [...dedupedIssues].sort((left, right) =>
    compareIssues(left, right, authoringIssues.length === 0 && structuralIssues.length > 0));
  const selectedIssues: AIDraftIssue[] = [];

  for (const issue of rankedIssues) {
    if (
      issue.phase === 'structural'
      && issue.code === 'schema.oneOf'
      && issue.path === '$'
      && rankedIssues.some((candidate) => candidate.path !== '$')
    ) {
      continue;
    }

    if (
      issue.phase === 'structural'
      && issue.code === 'schema.oneOf'
      && rankedIssues.some((candidate) => candidate !== issue && isSameOrDescendantPath(candidate.path, issue.path))
    ) {
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

function dedupeIssues(issues: AIDraftIssue[]) {
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

function compareIssues(left: AIDraftIssue, right: AIDraftIssue, structuralOnly: boolean) {
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

function getIssuePriority(issue: AIDraftIssue, structuralOnly: boolean) {
  if (issue.phase === 'authoring') {
    switch (issue.code) {
      case 'authoringMissingField':
        return 0;
      case 'authoringInvalidContext':
        return 1;
      case 'authoringUnsupportedOp':
        return 2;
      case 'authoringInvalidOperandSource':
        return 3;
      case 'authoringInvalidMatch':
      case 'authoringInvalidBetween':
        return 4;
      case 'authoringEmptyGroup':
        return 5;
      case 'authoringType':
        return 6;
      default:
        return 7;
    }
  }

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
    case 'emptyDraft':
      return 0;
    case 'missingColumn':
      return 1;
    case 'invalidExpression':
      return 2;
    case 'incompatibleType':
      return 3;
    case 'invalidRegex':
      return 4;
    case 'duplicateColumnReference':
      return 5;
    default:
      return 6;
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
