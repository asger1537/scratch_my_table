import { type ChangeEvent, type MutableRefObject, useEffect, useRef, useState } from 'react';

import * as Blockly from 'blockly';

import type { Table } from '../domain/model';
import type { Workflow } from '../workflow';

import type { AuthoringWorkflowMetadata } from './authoring';
import { BLOCK_TYPES, getWorkflowToolboxDefinition, registerWorkflowBlocks } from './blocks';
import {
  createDefaultWorkflow,
  getWorkspaceMetadata,
  projectWorkspaceStepSchemas,
  setWorkspaceMetadata,
  workflowToWorkspace,
  workspaceToWorkflow,
} from './mapping';
import { collectWorkflowColumnIds, setEditorSchemaColumns } from './schemaOptions';
import type { WorkspaceWorkflowResult } from './types';

interface WorkflowEditorProps {
  table: Table;
  loadWorkflow: Workflow | null;
  loadVersion: number;
  extraColumnIds: string[];
  onWorkspaceChange: (result: WorkspaceWorkflowResult) => void;
}

const STEP_BLOCK_TYPES = new Set<string>([
  BLOCK_TYPES.scopedTransformStep,
  BLOCK_TYPES.renameColumnStep,
  BLOCK_TYPES.deriveColumnStep,
  BLOCK_TYPES.filterRowsStep,
  BLOCK_TYPES.splitColumnStep,
  BLOCK_TYPES.combineColumnsStep,
  BLOCK_TYPES.deduplicateRowsStep,
  BLOCK_TYPES.sortRowsStep,
]);

export function WorkflowEditor({ table, loadWorkflow, loadVersion, extraColumnIds, onWorkspaceChange }: WorkflowEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const suppressChangesRef = useRef(false);
  const [metadata, setMetadata] = useState<AuthoringWorkflowMetadata>(() => getDefaultMetadata(table, loadWorkflow));
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const isFullscreen = isFallbackFullscreen;

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

      syncEditorSchema(workspace, table, extraColumnIds);
      onWorkspaceChange(workspaceToWorkflow(workspace));
    };

    workspace.addChangeListener(handleWorkspaceChange);

    const handleResize = () => {
      Blockly.svgResize(workspace);
    };

    window.addEventListener('resize', handleResize);

    loadWorkspace(workspace, table, loadWorkflow ?? createDefaultWorkflow(table), onWorkspaceChange, suppressChangesRef);
    syncEditorSchema(workspace, table, extraColumnIds);
    setMetadata(getWorkspaceMetadata(workspace));
    resizeWorkspace(workspace, true);

    return () => {
      window.removeEventListener('resize', handleResize);
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (workspaceRef.current) {
      syncEditorSchema(workspaceRef.current, table, extraColumnIds);
      resizeWorkspace(workspaceRef.current);
    }
  }, [extraColumnIds, table.schema.columns]);

  useEffect(() => {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    loadWorkspace(workspace, table, loadWorkflow ?? createDefaultWorkflow(table), onWorkspaceChange, suppressChangesRef);
    syncEditorSchema(workspace, table, extraColumnIds);
    setMetadata(getWorkspaceMetadata(workspace));
    resizeWorkspace(workspace, true);
  }, [loadVersion]);

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
    if (isFallbackFullscreen) {
      setIsFallbackFullscreen(false);
      return;
    }

    setIsFallbackFullscreen(true);
  }

  function handleMetadataChange(field: keyof Pick<AuthoringWorkflowMetadata, 'name' | 'description'>) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const workspace = workspaceRef.current;

      if (!workspace) {
        return;
      }

      const nextMetadata = {
        ...metadata,
        [field]: event.target.value,
      };

      setMetadata(nextMetadata);
      setWorkspaceMetadata(workspace, nextMetadata);
      onWorkspaceChange(workspaceToWorkflow(workspace));
    };
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
      <div className="workflow-editor-metadata">
        <label className="workflow-meta-field">
          <span>Workflow name</span>
          <input onChange={handleMetadataChange('name')} type="text" value={metadata.name} />
        </label>
        <label className="workflow-meta-field workflow-meta-field--wide">
          <span>Description</span>
          <textarea onChange={handleMetadataChange('description')} rows={2} value={metadata.description ?? ''} />
        </label>
      </div>
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
  suppressChangesRef.current = false;
  onWorkspaceChange(workspaceToWorkflow(workspace));
}

function syncEditorSchema(workspace: Blockly.Workspace, table: Table, extraColumnIds: string[]) {
  setEditorSchemaColumns(table.schema.columns, extraColumnIds, projectWorkspaceStepSchemas(workspace, table));
}

function focusPrimaryStep(workspace: Blockly.Workspace) {
  if (!('centerOnBlock' in workspace)) {
    return;
  }

  const root = workspace.getTopBlocks(true).find((block) => isStepBlockType(block.type));

  if (!root) {
    return;
  }

  (workspace as Blockly.WorkspaceSvg).centerOnBlock(root.id);
}

function resizeWorkspace(workspace: Blockly.WorkspaceSvg, focusRoot = false) {
  requestAnimationFrame(() => {
    Blockly.svgResize(workspace);

    if (focusRoot) {
      focusPrimaryStep(workspace);
    }
  });
}

function getDefaultMetadata(table: Table, workflow: Workflow | null): AuthoringWorkflowMetadata {
  const seedWorkflow = workflow ?? createDefaultWorkflow(table);

  return {
    workflowId: seedWorkflow.workflowId,
    name: seedWorkflow.name,
    description: seedWorkflow.description,
  };
}

function isStepBlockType(type: string) {
  return STEP_BLOCK_TYPES.has(type);
}
