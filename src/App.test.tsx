// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowTabs } from './App';
import type { Workflow } from './workflow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createWorkflow(workflowId: string, name: string): Workflow {
  return {
    version: 2,
    workflowId,
    name,
    description: '',
    steps: [],
  };
}

function WorkflowTabsHarness() {
  const [workflows, setWorkflows] = useState([createWorkflow('wf_workflow', 'Workflow')]);
  const [activeWorkflowId, setActiveWorkflowId] = useState('wf_workflow');
  const [startRenameWorkflowId, setStartRenameWorkflowId] = useState<string | null>(null);

  function handleCreateWorkflow() {
    const createdWorkflowId = 'wf_workflow_2';
    setWorkflows((current) => [...current, createWorkflow(createdWorkflowId, 'Workflow (2)')]);
    setActiveWorkflowId(createdWorkflowId);
    setStartRenameWorkflowId(createdWorkflowId);
  }

  return (
    <WorkflowTabs
      activeWorkflowId={activeWorkflowId}
      onCreateWorkflow={handleCreateWorkflow}
      onDeleteWorkflow={() => {}}
      onRenameWorkflow={() => {}}
      onSelectWorkflow={setActiveWorkflowId}
      onStartRenameHandled={() => setStartRenameWorkflowId(null)}
      startRenameWorkflowId={startRenameWorkflowId}
      workflowTabStates={{}}
      workflows={workflows}
    />
  );
}

async function flushUi() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
}

describe('WorkflowTabs', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('enters inline rename mode and focuses the input when creating a new workflow', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<WorkflowTabsHarness />);
    });

    const createButton = container.querySelector('.workflow-tab--create');

    if (!(createButton instanceof HTMLButtonElement)) {
      throw new Error('Expected workflow create button.');
    }

    await act(async () => {
      createButton.click();
    });
    await flushUi();

    const renameInput = container.querySelector('.workflow-tab__input');

    if (!(renameInput instanceof HTMLInputElement)) {
      throw new Error('Expected inline rename input after creating a workflow.');
    }

    expect(renameInput.value).toBe('Workflow (2)');
    expect(document.activeElement).toBe(renameInput);
    expect(renameInput.selectionStart).toBe(0);
    expect(renameInput.selectionEnd).toBe(renameInput.value.length);
  });
});
