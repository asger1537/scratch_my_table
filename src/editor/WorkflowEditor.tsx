import { type MutableRefObject, useEffect, useRef } from 'react';

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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const suppressChangesRef = useRef(false);

  useEffect(() => {
    registerWorkflowBlocks();

    if (!containerRef.current) {
      return;
    }

    const workspace = Blockly.inject(containerRef.current, {
      toolbox: getWorkflowToolboxDefinition(),
      move: {
        drag: true,
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
    Blockly.svgResize(workspace);

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
  }, [loadVersion]);

  return (
    <div className="workflow-editor-shell">
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
