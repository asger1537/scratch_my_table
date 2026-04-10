import { useEffect, useRef, useState } from 'react';

import * as Blockly from 'blockly';

import type { Table } from '../domain/model';
import type { Workflow } from '../workflow';

import { registerWorkflowBlocks } from './blocks';
import { projectWorkspaceStepSchemas, workflowToWorkspace } from './mapping';
import { refreshWorkspaceSchemaFields } from './schemaFieldRefresh';
import { captureEditorSchemaSnapshot, collectWorkflowColumnIds, restoreEditorSchemaSnapshot, setEditorSchemaColumns } from './schemaOptions';

interface WorkflowBlockPreviewProps {
  table: Table;
  workflow: Workflow;
}

export function WorkflowBlockPreview({ table, workflow }: WorkflowBlockPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const schemaSnapshotRef = useRef(captureEditorSchemaSnapshot());
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    registerWorkflowBlocks();

    if (!containerRef.current) {
      return;
    }

    const workspace = Blockly.inject(containerRef.current, {
      readOnly: true,
      move: {
        drag: true,
        scrollbars: true,
        wheel: true,
      },
      zoom: {
        controls: true,
        wheel: true,
      },
      trashcan: false,
    });

    workspaceRef.current = workspace;

    const handleResize = () => {
      resizePreviewWorkspace(workspace);
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      workspace.dispose();
      workspaceRef.current = null;
      restoreEditorSchemaSnapshot(schemaSnapshotRef.current);
    };
  }, []);

  useEffect(() => {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    try {
      const extraColumnIds = collectWorkflowColumnIds(workflow);

      setEditorSchemaColumns(table.schema.columns, extraColumnIds);
      workflowToWorkspace(workspace, workflow);
      setEditorSchemaColumns(table.schema.columns, extraColumnIds, projectWorkspaceStepSchemas(workspace, table));
      refreshWorkspaceSchemaFields(workspace);
      resizePreviewWorkspace(workspace, true);
      setLoadError(null);
    } catch (error) {
      workspace.clear();
      setLoadError(error instanceof Error ? error.message : 'Failed to render the draft block preview.');
    }
  }, [table, workflow]);

  return (
    <div className="workflow-block-preview">
      {loadError ? <div className="empty-panel empty-panel--compact">{loadError}</div> : null}
      <div className="workflow-editor-shell workflow-block-preview__shell">
        <div className="workflow-editor-canvas workflow-block-preview__canvas" ref={containerRef} />
      </div>
    </div>
  );
}

function resizePreviewWorkspace(workspace: Blockly.WorkspaceSvg, focusRoot = false) {
  requestAnimationFrame(() => {
    Blockly.svgResize(workspace);

    if (!focusRoot) {
      return;
    }

    const root = workspace.getTopBlocks(true)[0];

    if (!root || !('centerOnBlock' in workspace)) {
      return;
    }

    (workspace as Blockly.WorkspaceSvg).centerOnBlock(root.id);
  });
}
