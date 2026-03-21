import { type MutableRefObject, useEffect, useRef, useState } from 'react';

import * as Blockly from 'blockly';

import type { Table } from '../domain/model';
import type { Workflow } from '../workflow';

import { BLOCK_TYPES, getWorkflowToolboxDefinition, registerWorkflowBlocks } from './blocks';
import { createDefaultWorkflow, type WorkspaceWorkflowResult, workflowToWorkspace, workspaceToWorkflow } from './mapping';
import { collectWorkflowColumnIds, setEditorSchemaColumns } from './schemaOptions';

interface WorkflowEditorProps {
  table: Table;
  loadWorkflow: Workflow | null;
  loadVersion: number;
  extraColumnIds: string[];
  onWorkspaceChange: (result: WorkspaceWorkflowResult) => void;
}

export function WorkflowEditor({ table, loadWorkflow, loadVersion, extraColumnIds, onWorkspaceChange }: WorkflowEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const suppressChangesRef = useRef(false);
  const [isBrowserFullscreen, setIsBrowserFullscreen] = useState(false);
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const isFullscreen = isBrowserFullscreen || isFallbackFullscreen;

  useEffect(() => {
    registerWorkflowBlocks();

    if (!containerRef.current) {
      return;
    }

    const workspace = Blockly.inject(containerRef.current, {
      toolbox: getWorkflowToolboxDefinition(),
      move: {
        drag: true,
        scrollbars: true,
        wheel: true,
      },
      zoom: {
        controls: true,
        wheel: true,
      },
      trashcan: true,
    });

    workspaceRef.current = workspace;

    const handleWorkspaceChange = () => {
      if (suppressChangesRef.current) {
        return;
      }

      onWorkspaceChange(workspaceToWorkflow(workspace));
    };

    workspace.addChangeListener(handleWorkspaceChange);

    const handleResize = () => {
      Blockly.svgResize(workspace);
    };

    window.addEventListener('resize', handleResize);

    loadWorkspace(workspace, table, loadWorkflow ?? createDefaultWorkflow(table), onWorkspaceChange, suppressChangesRef);
    resizeWorkspace(workspace, true);

    return () => {
      window.removeEventListener('resize', handleResize);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    setEditorSchemaColumns(table.schema.columns, extraColumnIds);
  }, [extraColumnIds, table.schema.columns]);

  useEffect(() => {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    loadWorkspace(workspace, table, loadWorkflow ?? createDefaultWorkflow(table), onWorkspaceChange, suppressChangesRef);
    resizeWorkspace(workspace, true);
  }, [loadVersion]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const shell = shellRef.current;
      const nextIsBrowserFullscreen = shell !== null && document.fullscreenElement === shell;

      setIsBrowserFullscreen(nextIsBrowserFullscreen);

      if (!nextIsBrowserFullscreen) {
        const workspace = workspaceRef.current;

        if (workspace) {
          resizeWorkspace(workspace);
        }
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isFallbackFullscreen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFallbackFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isFallbackFullscreen]);

  useEffect(() => {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    resizeWorkspace(workspace);
  }, [isFullscreen]);

  async function handleToggleFullscreen() {
    const shell = shellRef.current;

    if (!shell) {
      return;
    }

    if (isBrowserFullscreen) {
      await document.exitFullscreen();
      return;
    }

    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false);
      return;
    }

    if ('requestFullscreen' in shell && typeof shell.requestFullscreen === 'function') {
      try {
        await shell.requestFullscreen();
        return;
      } catch {
        // Fall back to an in-page expanded editor when browser fullscreen is unavailable.
      }
    }

    setIsFallbackFullscreen(true);
  }

  return (
    <div className={`workflow-editor-shell${isFallbackFullscreen ? ' workflow-editor-shell--fullscreen' : ''}`} ref={shellRef}>
      <button
        aria-label={isFullscreen ? 'Exit fullscreen editor' : 'Open fullscreen editor'}
        className="workflow-editor-fullscreen"
        onClick={() => {
          void handleToggleFullscreen();
        }}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        type="button"
      >
        {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </button>
      <div className="workflow-editor-canvas" ref={containerRef} />
    </div>
  );
}

function loadWorkspace(
  workspace: Blockly.Workspace,
  table: Table,
  workflow: Workflow,
  onWorkspaceChange: (result: WorkspaceWorkflowResult) => void,
  suppressChangesRef: MutableRefObject<boolean>,
) {
  suppressChangesRef.current = true;
  setEditorSchemaColumns(table.schema.columns, collectWorkflowColumnIds(workflow));
  workflowToWorkspace(workspace, workflow);
  const root = workspace.getTopBlocks(false).find((block) => block.type === BLOCK_TYPES.workflowRoot);

  if (root) {
    root.setDeletable(false);
    root.setMovable(false);
  }

  suppressChangesRef.current = false;
  onWorkspaceChange(workspaceToWorkflow(workspace));
}

function focusWorkflowRoot(workspace: Blockly.Workspace) {
  if (!('centerOnBlock' in workspace)) {
    return;
  }

  const root = workspace.getTopBlocks(false).find((block) => block.type === BLOCK_TYPES.workflowRoot);

  if (!root) {
    return;
  }

  (workspace as Blockly.WorkspaceSvg).centerOnBlock(root.id);
}

function resizeWorkspace(workspace: Blockly.WorkspaceSvg, focusRoot = false) {
  requestAnimationFrame(() => {
    Blockly.svgResize(workspace);

    if (focusRoot) {
      focusWorkflowRoot(workspace);
    }
  });
}
