import type { Table } from '../domain/model';
import type { Workflow, WorkflowStep, WorkflowValidationIssue } from '../workflow';

export type WorkflowStepInput =
  WorkflowStep extends infer Step
    ? Step extends { id: string }
      ? Omit<Step, 'id'>
      : never
    : never;

export interface AISettings {
  apiKey: string;
  model: string;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}

export interface AIProgressEvent {
  stage:
    | 'start'
    | 'request_initial'
    | 'response_initial'
    | 'validate_initial'
    | 'repair_requested'
    | 'request_repair'
    | 'response_repair'
    | 'validate_repair'
    | 'complete'
    | 'error';
  message: string;
  timestamp: string;
}

export interface GeminiClientLogEvent {
  phase: 'initial' | 'repair';
  kind: 'request_started' | 'response_received' | 'response_parsed' | 'request_failed';
  message: string;
  rawText?: string;
  error?: string;
  responseMode?: 'clarify' | 'draft';
  timestamp: string;
}

export interface GeminiWorkflowResponse {
  mode: 'clarify' | 'draft';
  assistantMessage: string;
  assumptions: string[];
  steps?: WorkflowStepInput[];
}

export interface AIDebugTrace {
  outcomeKind: 'clarify' | 'draft' | 'invalidDraft';
  repaired: boolean;
  initialRawText: string;
  initialResponse: GeminiWorkflowResponse;
  initialValidationIssues: WorkflowValidationIssue[];
  repairRawText?: string;
  repairResponse?: GeminiWorkflowResponse;
  repairValidationIssues: WorkflowValidationIssue[];
}

export interface AIDraft {
  steps: WorkflowStep[];
  assumptions: string[];
  assistantMessage: string;
  validationIssues: WorkflowValidationIssue[];
}

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
  onLogEvent?: (event: GeminiClientLogEvent) => void;
}

export interface GeminiDraftTurnResult {
  response: GeminiWorkflowResponse;
  rawText: string;
}
