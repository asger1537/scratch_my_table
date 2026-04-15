import type { Workflow, WorkflowValidationIssue } from '../workflow';
import { flattenWorkflowSequence } from '../workflowPackage';

import { mapWorkflowValidationIssueToAIDraftIssue } from './compileAuthoringDraft';
import type { AuthoringDraftResponse } from './authoringIr';
import { assignWorkflowStepIds, replaceWorkflowSteps } from './draft';
import { evaluateDraftQuality } from './evaluateDraftQuality';
import { generateGeminiChecklistVerificationTurn, generateGeminiDraftTurn, generateGeminiRequirementPlanTurn } from './gemini';
import { buildRepairUserMessage } from './prompt';
import { selectRelevantValidationIssues as selectRelevantRepairValidationIssues, selectRepairPromptIssues } from './repairIssues';
import type { AIDraftIssue } from './authoringIr';
import type {
  AIDebugRepairAttempt,
  AIProgressEvent,
  AIDebugTrace,
  AIDraft,
  AIChecklistVerificationAttempt,
  AIChecklistVerificationResponse,
  AIMessage,
  AIRequirementPlanResponse,
  CompiledAuthoringDraft,
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
  validateCandidateWorkflowSet?: (workflows: Workflow[], runOrderWorkflowIds: string[]) => Promise<WorkflowValidationIssue[]>;
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

  emitProgress(options, 'request_plan', 'Sending requirement planning request.');
  const requirementPlanTurn = await generateGeminiRequirementPlanTurn(
    {
      settings: options.settings,
      context: options.context,
      userMessage,
      onLogEvent: options.onGeminiLogEvent,
    },
    options.fetchFn,
  );
  emitProgress(options, 'response_plan', `Received requirement plan response in mode "${requirementPlanTurn.response.mode}".`);

  if (requirementPlanTurn.response.mode === 'clarify') {
    const clarifyResponse: AuthoringDraftResponse = {
      mode: 'clarify',
      msg: requirementPlanTurn.response.msg,
      ass: requirementPlanTurn.response.ass,
      steps: [],
    };

    emitProgress(options, 'complete', 'AI turn completed with a planning clarification question.');
    return {
      kind: 'clarify',
      userMessage,
      assistantMessage: createMessage('assistant', requirementPlanTurn.response.msg),
      response: clarifyResponse,
      repaired: false,
      debugTrace: {
        outcomeKind: 'clarify',
        repaired: false,
        requirementPlanRawText: requirementPlanTurn.rawText,
        requirementPlan: requirementPlanTurn.response,
        initialRawText: '',
        initialResponse: clarifyResponse,
        initialCompilationIssues: [],
        initialValidationIssues: [],
        verificationAttempts: [],
        repairAttempts: [],
      },
    };
  }
  const requirementPlan = requirementPlanTurn.response;

  const forcedSplitClarificationMessage = getForcedWorkflowSplitClarificationMessage(options, requirementPlan);

  if (forcedSplitClarificationMessage) {
    const clarifyResponse: AuthoringDraftResponse = {
      mode: 'clarify',
      msg: forcedSplitClarificationMessage,
      ass: requirementPlan.ass,
      steps: [],
    };

    emitProgress(options, 'complete', 'AI turn completed with a deterministic workflow-split clarification question.');
    return {
      kind: 'clarify',
      userMessage,
      assistantMessage: createMessage('assistant', forcedSplitClarificationMessage),
      response: clarifyResponse,
      repaired: false,
      debugTrace: {
        outcomeKind: 'clarify',
        repaired: false,
        requirementPlanRawText: requirementPlanTurn.rawText,
        requirementPlan: requirementPlanTurn.response,
        initialRawText: '',
        initialResponse: clarifyResponse,
        initialCompilationIssues: [],
        initialValidationIssues: [],
        verificationAttempts: [],
        repairAttempts: [],
      },
    };
  }

  emitProgress(options, 'request_initial', 'Sending initial Gemini request.');
  const initialTurn = await generateGeminiDraftTurn(
    {
      settings: options.settings,
      context: options.context,
      userMessage,
      phase: 'initial',
      promptOptions: {
        requirementPlan,
      },
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
        requirementPlanRawText: requirementPlanTurn.rawText,
        requirementPlan: requirementPlanTurn.response,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        initialCompilationIssues: [],
        initialValidationIssues: [],
        verificationAttempts: [],
        repairAttempts: [],
      },
    };
  }

  emitProgress(options, 'validate_initial', 'Compiling and validating the initial AI draft.');
  const verificationAttempts: AIChecklistVerificationAttempt[] = [];
  const initialValidation = await validateDraftResponse(
    options.context,
    options.userText,
    initialTurn.compilationIssues,
    initialTurn.compiledDraft,
    options.validateCandidateWorkflow,
    options.validateCandidateWorkflowSet,
    async (draft) => verifyDraftChecklist(options, userMessage, requirementPlan, draft, {
      target: 'initial',
    }),
  );
  if (initialValidation.verificationAttempt) {
    verificationAttempts.push(initialValidation.verificationAttempt);
  }
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
        requirementPlanRawText: requirementPlanTurn.rawText,
        requirementPlan: requirementPlanTurn.response,
        initialRawText: initialTurn.rawText,
        initialResponse: initialTurn.response,
        ...(initialTurn.compiledDraft ? { initialCompiledDraft: initialTurn.compiledDraft } : {}),
        initialCompilationIssues: initialTurn.compilationIssues,
        initialValidationIssues: [],
        verificationAttempts,
        repairAttempts: [],
      },
      draft: withResponseMetadata(initialValidation.draft, initialTurn.response),
    };
  }

  const repairAttempts: AIDebugRepairAttempt[] = [];
  let previousRawText = initialTurn.rawText;
  let previousResponse: AuthoringDraftResponse = initialTurn.response;
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
      buildRepairUserMessage(previousRawText, repairPromptIssues, options.context, requirementPlan),
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
        promptOptions: {
          requirementPlan,
        },
        onLogEvent: options.onGeminiLogEvent,
      },
      options.fetchFn,
    );
    emitProgress(options, 'response_repair', `Received repair response ${attempt} of ${MAX_REPAIR_ATTEMPTS} in mode "${repairTurn.response.mode}".`, attempt);

    if (repairTurn.response.mode === 'clarify') {
      repairAttempts.push({
        attempt,
        repairPromptIssues,
        rawText: repairTurn.rawText,
        response: repairTurn.response,
        ...(repairTurn.compiledDraft ? { compiledDraft: repairTurn.compiledDraft } : {}),
        compilationIssues: repairTurn.compilationIssues,
        validationIssues: [],
        verificationIssues: [],
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
          requirementPlanTurn,
          initialValidationIssues: initialRelevantIssues,
          verificationAttempts,
          repairAttempts,
        }),
      };
    }

    emitProgress(options, 'validate_repair', `Compiling and validating repaired draft ${attempt} of ${MAX_REPAIR_ATTEMPTS}.`, attempt);
    const repairedValidation = await validateDraftResponse(
      options.context,
      options.userText,
      repairTurn.compilationIssues,
      repairTurn.compiledDraft,
      options.validateCandidateWorkflow,
      options.validateCandidateWorkflowSet,
      async (draft) => verifyDraftChecklist(options, userMessage, requirementPlan, draft, {
        target: 'repair',
        attempt,
      }),
    );
    if (repairedValidation.verificationAttempt) {
      verificationAttempts.push(repairedValidation.verificationAttempt);
    }
    const repairRelevantIssues = selectRelevantRepairValidationIssues(repairedValidation.issues);

    repairAttempts.push({
      attempt,
      repairPromptIssues,
      rawText: repairTurn.rawText,
      response: repairTurn.response,
      ...(repairTurn.compiledDraft ? { compiledDraft: repairTurn.compiledDraft } : {}),
      compilationIssues: repairTurn.compilationIssues,
      validationIssues: repairRelevantIssues,
      verificationIssues: repairedValidation.verificationAttempt?.issues ?? [],
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
          requirementPlanTurn,
          initialValidationIssues: initialRelevantIssues,
          verificationAttempts,
          repairAttempts,
        }),
        draft: withResponseMetadata(repairedValidation.draft, repairTurn.response),
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
      requirementPlanTurn,
      initialValidationIssues: initialRelevantIssues,
      verificationAttempts,
      repairAttempts,
    }),
  };
}

function buildDebugTrace(input: {
  outcomeKind: AIDebugTrace['outcomeKind'];
  repaired: boolean;
  requirementPlanTurn: {
    response: AIRequirementPlanResponse;
    rawText: string;
  };
  initialTurn: GeminiDraftTurnResult;
  initialValidationIssues: AIDraftIssue[];
  verificationAttempts: AIChecklistVerificationAttempt[];
  repairAttempts: AIDebugRepairAttempt[];
}): AIDebugTrace {
  return {
    outcomeKind: input.outcomeKind,
    repaired: input.repaired,
    requirementPlanRawText: input.requirementPlanTurn.rawText,
    requirementPlan: input.requirementPlanTurn.response,
    initialRawText: input.initialTurn.rawText,
    initialResponse: input.initialTurn.response,
    ...(input.initialTurn.compiledDraft ? { initialCompiledDraft: input.initialTurn.compiledDraft } : {}),
    initialCompilationIssues: input.initialTurn.compilationIssues,
    initialValidationIssues: input.initialValidationIssues,
    verificationAttempts: input.verificationAttempts,
    repairAttempts: input.repairAttempts,
  };
}

async function validateDraftResponse(
  context: AIPromptContext,
  userText: string,
  compilationIssues: AIDraftIssue[],
  compiledDraft: CompiledAuthoringDraft | undefined,
  validateCandidateWorkflow: (workflow: AIPromptContext['workflow']) => Promise<WorkflowValidationIssue[]>,
  validateCandidateWorkflowSet: RunGeminiDraftTurnOptions['validateCandidateWorkflowSet'],
  verifyChecklist: (draft: AIDraft) => Promise<AIChecklistVerificationAttempt>,
): Promise<{ draft: AIDraft; steps: ReturnType<typeof assignWorkflowStepIds>; issues: AIDraftIssue[]; verificationAttempt?: AIChecklistVerificationAttempt }> {
  if (compilationIssues.length > 0 || !compiledDraft) {
    return {
      draft: createEmptySingleDraft(),
      steps: [],
      issues: compilationIssues,
    };
  }

  if (compiledDraft.kind === 'singleWorkflow') {
    return withChecklistVerification(await validateSingleWorkflowDraftResponse(
      context,
      userText,
      compiledDraft.steps,
      validateCandidateWorkflow,
    ), verifyChecklist);
  }

  return withChecklistVerification(await validateWorkflowSetDraftResponse(
    context,
    userText,
    compiledDraft,
    validateCandidateWorkflowSet,
  ), verifyChecklist);
}

async function validateSingleWorkflowDraftResponse(
  context: AIPromptContext,
  userText: string,
  compiledStepInputs: WorkflowStepInput[],
  validateCandidateWorkflow: (workflow: AIPromptContext['workflow']) => Promise<WorkflowValidationIssue[]>,
): Promise<{ draft: AIDraft; steps: ReturnType<typeof assignWorkflowStepIds>; issues: AIDraftIssue[] }> {
  if (compiledStepInputs.length === 0) {
    return {
      draft: createEmptySingleDraft(),
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
    draft: {
      kind: 'singleWorkflow',
      steps,
      assumptions: [],
      assistantMessage: '',
      validationIssues: [],
    },
    steps,
    issues: [...issues, ...qualityIssues],
  };
}

async function withChecklistVerification<T extends { draft: AIDraft; steps: ReturnType<typeof assignWorkflowStepIds>; issues: AIDraftIssue[] }>(
  validation: T,
  verifyChecklist: (draft: AIDraft) => Promise<AIChecklistVerificationAttempt>,
): Promise<T & { verificationAttempt?: AIChecklistVerificationAttempt }> {
  if (validation.issues.length > 0) {
    return validation;
  }

  const verificationAttempt = await verifyChecklist(validation.draft);

  return {
    ...validation,
    verificationAttempt,
    issues: [...validation.issues, ...verificationAttempt.issues],
  };
}

async function validateWorkflowSetDraftResponse(
  context: AIPromptContext,
  userText: string,
  compiledDraft: Extract<CompiledAuthoringDraft, { kind: 'workflowSet' }>,
  validateCandidateWorkflowSet: RunGeminiDraftTurnOptions['validateCandidateWorkflowSet'],
): Promise<{ draft: AIDraft; steps: ReturnType<typeof assignWorkflowStepIds>; issues: AIDraftIssue[] }> {
  const workflows = compiledDraft.workflows.map((workflow) => ({
    version: 2 as const,
    workflowId: workflow.workflowId,
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    steps: assignWorkflowStepIds(workflow.steps),
  }));
  const flattenedSteps = flattenWorkflowSequence(workflows, compiledDraft.runOrderWorkflowIds).workflow.steps;
  const draft: AIDraft = {
    kind: 'workflowSet',
    applyMode: compiledDraft.applyMode,
    workflows,
    runOrderWorkflowIds: compiledDraft.runOrderWorkflowIds,
    assumptions: [],
    assistantMessage: '',
    validationIssues: [],
  };

  if (!validateCandidateWorkflowSet) {
    return {
      draft,
      steps: flattenedSteps,
      issues: [
        {
          code: 'workflowSetValidationUnavailable',
          severity: 'error',
          message: 'Workflow-set drafts require sequence-aware validation.',
          path: 'workflows',
          phase: 'authoring',
        },
      ],
    };
  }

  const issues = (await validateCandidateWorkflowSet(workflows, compiledDraft.runOrderWorkflowIds)).map(mapWorkflowValidationIssueToAIDraftIssue);
  const qualityIssues = evaluateDraftQuality({
    context,
    userText,
    steps: flattenedSteps,
  });

  return {
    draft,
    steps: flattenedSteps,
    issues: [...issues, ...qualityIssues],
  };
}

function withResponseMetadata(draft: AIDraft, response: Exclude<AuthoringDraftResponse, { mode: 'clarify' }>): AIDraft {
  if (draft.kind === 'workflowSet') {
    return {
      ...draft,
      assumptions: response.ass,
      assistantMessage: response.msg,
    };
  }

  return {
    ...draft,
    assumptions: response.ass,
    assistantMessage: response.msg,
  };
}

function createEmptySingleDraft(): AIDraft {
  return {
    kind: 'singleWorkflow',
    steps: [],
    assumptions: [],
    assistantMessage: '',
    validationIssues: [],
  };
}

async function verifyDraftChecklist(
  options: RunGeminiDraftTurnOptions,
  userMessage: AIMessage,
  requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>,
  draft: AIDraft,
  target: Pick<AIChecklistVerificationAttempt, 'target' | 'attempt'>,
): Promise<AIChecklistVerificationAttempt> {
  emitProgress(
    options,
    'request_verify',
    target.target === 'initial'
      ? 'Sending checklist verification request.'
      : `Sending checklist verification request for repair ${target.attempt}.`,
    target.attempt,
  );

  const verificationTurn = await generateGeminiChecklistVerificationTurn(
    {
      settings: options.settings,
      context: options.context,
      userMessage,
      requirementPlan,
      draft,
      onLogEvent: options.onGeminiLogEvent,
    },
    options.fetchFn,
  );
  const issues = mapChecklistVerificationIssues(verificationTurn.response, requirementPlan);

  emitProgress(
    options,
    'response_verify',
    `Checklist verification ${verificationTurn.response.status === 'pass' ? 'passed' : `failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`}.`,
    target.attempt,
  );

  return {
    ...target,
    rawText: verificationTurn.rawText,
    response: verificationTurn.response,
    issues,
  };
}

function mapChecklistVerificationIssues(
  response: AIChecklistVerificationResponse,
  requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>,
): AIDraftIssue[] {
  const checklistIds = new Set(requirementPlan.checklist.map((item) => item.id));
  const issues = response.issues.map((issue): AIDraftIssue => ({
    code: 'taskQualityChecklistNotSatisfied',
    severity: 'warning',
    phase: 'semantic',
    path: `checklist.${sanitizeIssuePathSegment(issue.checklistId)}`,
    message: `Checklist item '${issue.checklistId}' is not satisfied: ${issue.message}`,
    details: {
      checklistId: issue.checklistId,
      verifierCode: issue.code,
      knownChecklistId: checklistIds.has(issue.checklistId),
    },
  }));

  if (response.status === 'fail' && issues.length === 0) {
    return [
      {
        code: 'taskQualityChecklistNotSatisfied',
        severity: 'warning',
        phase: 'semantic',
        path: 'checklist',
        message: 'Checklist verification failed but did not return a concrete issue. Review the approved checklist and repair any unmet item.',
      },
    ];
  }

  return issues;
}

function sanitizeIssuePathSegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'unknown';
}

function getForcedWorkflowSplitClarificationMessage(
  options: RunGeminiDraftTurnOptions,
  requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>,
) {
  const userConversationText = [
    ...options.context.messages.filter((message) => message.role === 'user').map((message) => message.text),
    options.userText,
  ].join('\n');

  if (requirementPlan.draftKind === 'workflowSet' && !hasExplicitWorkflowSetApplyChoice(userConversationText)) {
    return buildForcedWorkflowSetApplyModeClarificationMessage(requirementPlan);
  }

  if (
    requirementPlan.draftKind === 'singleWorkflow'
    && !hasExplicitSingleWorkflowRequest(userConversationText)
    && (countNumberedGoalHeadings(options.userText) >= 5 || countMajorConcernSignals(options.userText) >= 5)
  ) {
    return buildForcedWorkflowSplitClarificationMessage();
  }

  return null;
}

function hasExplicitSingleWorkflowRequest(userText: string) {
  return /\b(?:one|single)\s+workflow\b|\bkeep\s+(?:it|this|everything)\s+(?:as|in)\s+(?:one|a single)\s+workflow\b|\bdo\s+not\s+split\b|\bdon't\s+split\b/i.test(userText);
}

function hasExplicitWorkflowSetApplyChoice(text: string) {
  return /\bappend\b|\badd (?:them|these|the workflows)\b|\breplace\s+(?:the\s+)?active\s+workflow\b|\breplace\s+(?:the\s+)?(?:full\s+)?(?:workflow\s+)?package\b|\breplace\s+all\s+workflows\b/i.test(text);
}

function countNumberedGoalHeadings(userText: string) {
  const goalNumbers = new Set<string>();

  for (const match of userText.matchAll(/(?:^|\n)\s*(?:goal|step|phase)\s*(\d+)\s*[:.)-]/gi)) {
    goalNumbers.add(match[1]);
  }

  return goalNumbers.size;
}

function countMajorConcernSignals(userText: string) {
  const normalized = userText.toLocaleLowerCase();
  const concerns = [
    /\b(?:normalize|clean|trim|lowercase|uppercase|whitespace)\b/,
    /\b(?:derive|create|classify|bucket|segment)\b/,
    /\b(?:format|highlight|color|colour)\b/,
    /\b(?:cleanup|clean up|drop|remove helper)\b/,
    /\b(?:filter|keep rows|drop rows)\b/,
    /\b(?:dedupe|deduplicate|duplicate)\b/,
    /\b(?:sort|order|tie-break)\b/,
  ];

  return concerns.filter((pattern) => pattern.test(normalized)).length;
}

function buildForcedWorkflowSplitClarificationMessage() {
  return [
    'This is a large multi-concern request that is likely cleaner as multiple workflows run in sequence.',
    'I recommend splitting it into workflows such as "Normalize source fields", "Derive classifications", and "Finalize rows", run in that order.',
    'Should I append those workflows, replace the active workflow, or replace the full workflow package?',
  ].join(' ');
}

function buildForcedWorkflowSetApplyModeClarificationMessage(requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>) {
  const workflowNames = requirementPlan.workflowPlan?.workflows?.map((workflow) => workflow.name).filter(Boolean) ?? [];
  const workflowSummary = workflowNames.length > 0
    ? `I can create the workflow sequence ${workflowNames.map((name) => `"${name}"`).join(' -> ')}.`
    : 'I can create this as a workflow sequence.';

  return [
    workflowSummary,
    'Before I generate/apply that workflow set, should I append it, replace the active workflow, or replace the full workflow package?',
  ].join(' ');
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
