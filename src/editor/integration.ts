import type * as Blockly from 'blockly';

import type { Table } from '../domain/model';
import { executeWorkflow, validateWorkflowSemantics, validateWorkflowStructure, type Workflow, type WorkflowExecutionResult, type WorkflowValidationIssue } from '../workflow';

import { type EditorIssue, workspaceToWorkflow } from './mapping';

export interface EditorValidationResult {
  workflow: Workflow | null;
  editorIssues: EditorIssue[];
  validationIssues: WorkflowValidationIssue[];
}

export function validateWorkspaceWorkflow(workspace: Blockly.Workspace, table: Table): EditorValidationResult {
  const authored = workspaceToWorkflow(workspace);

  if (!authored.workflow) {
    return {
      workflow: null,
      editorIssues: authored.issues,
      validationIssues: [],
    };
  }

  const structural = validateWorkflowStructure(authored.workflow);

  if (!structural.valid || !structural.workflow) {
    return {
      workflow: authored.workflow,
      editorIssues: authored.issues,
      validationIssues: structural.issues,
    };
  }

  const semantic = validateWorkflowSemantics(structural.workflow, table);

  return {
    workflow: structural.workflow,
    editorIssues: authored.issues,
    validationIssues: semantic.issues,
  };
}

export function runWorkspaceWorkflow(
  workspace: Blockly.Workspace,
  table: Table,
): EditorValidationResult & { executionResult: WorkflowExecutionResult | null } {
  const validation = validateWorkspaceWorkflow(workspace, table);

  if (validation.editorIssues.length > 0 || validation.validationIssues.length > 0 || !validation.workflow) {
    return {
      ...validation,
      executionResult: null,
    };
  }

  return {
    ...validation,
    executionResult: executeWorkflow(validation.workflow, table),
  };
}
