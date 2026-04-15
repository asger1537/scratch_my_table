import type { Table } from '../domain/model';
import type { Workflow, WorkflowStep } from '../workflow';

import type { AIDraftIssue, AuthoringDraftResponse, AuthoringWorkflowSetApplyMode } from './authoringIr';

export type WorkflowStepInput =
  WorkflowStep extends infer Step
    ? Step extends { id: string }
      ? Omit<Step, 'id'>
      : never
    : never;

export interface AISettings {
  apiKey: string;
  model: string;
  thinkingEnabled: boolean;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface AIProgressEvent {
  stage:
    | 'start'
    | 'request_plan'
    | 'response_plan'
    | 'request_initial'
    | 'response_initial'
    | 'validate_initial'
    | 'request_verify'
    | 'response_verify'
    | 'repair_requested'
    | 'request_repair'
    | 'response_repair'
    | 'validate_repair'
    | 'complete'
    | 'error';
  message: string;
  timestamp: string;
  attempt?: number;
}

export interface GeminiClientLogEvent {
  phase: 'plan' | 'initial' | 'repair' | 'verify';
  kind: 'request_started' | 'response_received' | 'response_parsed' | 'request_failed';
  message: string;
  rawText?: string;
  error?: string;
  requestExport?: Record<string, unknown>;
  statusCode?: number;
  responseBody?: string;
  responseMode?: AuthoringDraftResponse['mode'];
  timestamp: string;
}

export interface AIRepairIssueSummary {
  code: string;
  path: string;
  message: string;
  stepId?: string;
}

export interface AIDebugRepairAttempt {
  attempt: number;
  repairPromptIssues: AIRepairIssueSummary[];
  rawText: string;
  response: AuthoringDraftResponse;
  compiledDraft?: CompiledAuthoringDraft;
  compilationIssues: AIDraftIssue[];
  validationIssues: AIDraftIssue[];
  verificationIssues: AIDraftIssue[];
}

export interface AIRequirementChecklistItem {
  id: string;
  requirement: string;
  acceptanceCriteria: string[];
}

export type AIRequirementPlanResponse =
  | {
      mode: 'clarify';
      msg: string;
      ass: string[];
    }
  | {
      mode: 'plan';
      msg: string;
      ass: string[];
      draftKind: 'singleWorkflow' | 'workflowSet';
      checklist: AIRequirementChecklistItem[];
      workflowPlan?: {
        applyMode?: AuthoringWorkflowSetApplyMode;
        workflows?: Array<{
          workflowId: string;
          name: string;
          description?: string;
        }>;
        runOrderWorkflowIds?: string[];
      };
    };

export interface AIChecklistVerificationIssue {
  checklistId: string;
  code: string;
  message: string;
}

export interface AIChecklistVerificationResponse {
  status: 'pass' | 'fail';
  issues: AIChecklistVerificationIssue[];
}

export interface AIChecklistVerificationAttempt {
  target: 'initial' | 'repair';
  attempt?: number;
  rawText: string;
  response: AIChecklistVerificationResponse;
  issues: AIDraftIssue[];
}

export interface AIDebugTrace {
  outcomeKind: 'clarify' | 'draft' | 'invalidDraft';
  repaired: boolean;
  requirementPlanRawText?: string;
  requirementPlan?: AIRequirementPlanResponse;
  initialRawText: string;
  initialResponse: AuthoringDraftResponse;
  initialCompiledDraft?: CompiledAuthoringDraft;
  initialCompilationIssues: AIDraftIssue[];
  initialValidationIssues: AIDraftIssue[];
  verificationAttempts: AIChecklistVerificationAttempt[];
  repairAttempts: AIDebugRepairAttempt[];
}

export interface CompiledAuthoringSingleWorkflowDraft {
  kind: 'singleWorkflow';
  steps: WorkflowStepInput[];
}

export interface CompiledAuthoringWorkflowSetDraft {
  kind: 'workflowSet';
  applyMode: AuthoringWorkflowSetApplyMode;
  workflows: Array<{
    workflowId: string;
    name: string;
    description?: string;
    steps: WorkflowStepInput[];
  }>;
  runOrderWorkflowIds: string[];
}

export type CompiledAuthoringDraft =
  | CompiledAuthoringSingleWorkflowDraft
  | CompiledAuthoringWorkflowSetDraft;

export interface AISingleWorkflowDraft {
  kind: 'singleWorkflow';
  steps: WorkflowStep[];
  assumptions: string[];
  assistantMessage: string;
  validationIssues: AIDraftIssue[];
}

export interface AIWorkflowSetDraft {
  kind: 'workflowSet';
  applyMode: AuthoringWorkflowSetApplyMode;
  workflows: Workflow[];
  runOrderWorkflowIds: string[];
  assumptions: string[];
  assistantMessage: string;
  validationIssues: AIDraftIssue[];
}

export type AIDraft =
  | AISingleWorkflowDraft
  | AIWorkflowSetDraft;

export interface AIPromptIssue {
  code: string;
  message: string;
}

export interface AIPromptContext {
  table: Table;
  workflow: Workflow;
  draft: AIDraft | null;
  messages: AIMessage[];
  currentIssues: AIPromptIssue[];
  workflowContextSource: 'current' | 'lastValidSnapshot';
  workspacePromptSnapshot: string;
}

export interface GeminiDraftTurnInput {
  settings: AISettings;
  context: AIPromptContext;
  userMessage: AIMessage;
  phase?: 'initial' | 'repair';
  promptOptions?: {
    includeCuratedExamples?: boolean;
    requirementPlan?: Extract<AIRequirementPlanResponse, { mode: 'plan' }>;
  };
  onLogEvent?: (event: GeminiClientLogEvent) => void;
}

export interface GeminiDraftTurnResult {
  response: AuthoringDraftResponse;
  rawText: string;
  compiledDraft?: CompiledAuthoringDraft;
  compilationIssues: AIDraftIssue[];
}
