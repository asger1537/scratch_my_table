// @vitest-environment jsdom

import { act } from 'react';
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
  return (
    <WorkflowTabs
      activeWorkflowId="wf_workflow"
      onCreateWorkflow={() => {}}
      onDeleteWorkflow={() => {}}
      onRenameWorkflow={() => {}}
      onSelectWorkflow={() => {}}
      workflowTabStates={{}}
      workflows={[createWorkflow('wf_workflow', 'Workflow')]}
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

  it('enters inline rename mode and focuses the input on manual rename', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root.render(<WorkflowTabsHarness />);
    });

    const workflowButton = container.querySelector('.workflow-tab__button');

    if (!(workflowButton instanceof HTMLButtonElement)) {
      throw new Error('Expected workflow tab button.');
    }

    await act(async () => {
      workflowButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await flushUi();

    const renameInput = container.querySelector('.workflow-tab__input');

    if (!(renameInput instanceof HTMLInputElement)) {
      throw new Error('Expected inline rename input after starting rename.');
    }

    expect(renameInput.value).toBe('Workflow');
    expect(document.activeElement).toBe(renameInput);
    expect(renameInput.selectionStart).toBe(0);
    expect(renameInput.selectionEnd).toBe(renameInput.value.length);
  });
});
