import { describe, expect, it } from 'vitest';

import { applyWorkflowSetDraftToPackage } from './workflowSetDraft';
import type { AIWorkflowSetDraft } from './types';
import { createWorkflowPackage } from '../workflowPackage';
import type { Workflow } from '../workflow';

describe('applyWorkflowSetDraftToPackage', () => {
  it('appends generated workflows and sets run order to the generated sequence', () => {
    const currentPackage = createWorkflowPackage([createWorkflow('wf_existing', 'Existing workflow')], 'wf_existing', ['wf_existing']);
    const draft = createWorkflowSetDraft('append');

    const applied = applyWorkflowSetDraftToPackage(currentPackage, 'wf_existing', draft);

    expect(applied.workflowPackage.workflows.map((workflow) => workflow.workflowId)).toEqual([
      'wf_existing',
      'wf_prepare',
      'wf_filter',
    ]);
    expect(applied.workflowPackage.runOrderWorkflowIds).toEqual(['wf_prepare', 'wf_filter']);
    expect(applied.workflowPackage.activeWorkflowId).toBe('wf_prepare');
  });

  it('replaces only the active workflow for replaceActive drafts', () => {
    const currentPackage = createWorkflowPackage(
      [
        createWorkflow('wf_active', 'Active workflow'),
        createWorkflow('wf_other', 'Other workflow'),
      ],
      'wf_active',
      ['wf_active', 'wf_other'],
    );
    const draft = createWorkflowSetDraft('replaceActive');

    const applied = applyWorkflowSetDraftToPackage(currentPackage, 'wf_active', draft);

    expect(applied.workflowPackage.workflows.map((workflow) => workflow.workflowId)).toEqual([
      'wf_active',
      'wf_other',
      'wf_filter',
    ]);
    expect(applied.workflowPackage.workflows.find((workflow) => workflow.workflowId === 'wf_active')?.name).toBe('Prepare');
    expect(applied.workflowPackage.runOrderWorkflowIds).toEqual(['wf_active', 'wf_filter']);
    expect(applied.workflowPackage.activeWorkflowId).toBe('wf_active');
  });

  it('replaces the whole package for replacePackage drafts', () => {
    const currentPackage = createWorkflowPackage([createWorkflow('wf_existing', 'Existing workflow')], 'wf_existing', ['wf_existing']);
    const draft = createWorkflowSetDraft('replacePackage');

    const applied = applyWorkflowSetDraftToPackage(currentPackage, 'wf_existing', draft);

    expect(applied.workflowPackage.workflows.map((workflow) => workflow.workflowId)).toEqual(['wf_prepare', 'wf_filter']);
    expect(applied.workflowPackage.runOrderWorkflowIds).toEqual(['wf_prepare', 'wf_filter']);
    expect(applied.workflowPackage.activeWorkflowId).toBe('wf_prepare');
  });
});

function createWorkflowSetDraft(applyMode: AIWorkflowSetDraft['applyMode']): AIWorkflowSetDraft {
  return {
    kind: 'workflowSet',
    applyMode,
    assumptions: [],
    assistantMessage: 'Draft workflows.',
    validationIssues: [],
    workflows: [
      createWorkflow('wf_prepare', 'Prepare'),
      createWorkflow('wf_filter', 'Filter'),
    ],
    runOrderWorkflowIds: ['wf_prepare', 'wf_filter'],
  };
}

function createWorkflow(workflowId: string, name: string): Workflow {
  return {
    version: 2,
    workflowId,
    name,
    steps: [
      {
        id: 'step_comment_1',
        type: 'comment',
        text: 'Test step.',
      },
    ],
  };
}
