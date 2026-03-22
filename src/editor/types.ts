import type { Workflow } from '../workflow';

export interface EditorIssue {
  code: string;
  message: string;
  blockId?: string;
  blockType?: string;
}

export interface WorkspaceWorkflowResult {
  workflow: Workflow | null;
  issues: EditorIssue[];
}
