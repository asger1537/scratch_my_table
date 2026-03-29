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

interface DeferredWorkspaceInputs {
  table: Table;
  extraColumnIds: string[];
  onWorkspaceChange: (result: WorkspaceWorkflowResult) => void;
}

const STEP_BLOCK_TYPES = new Set<string>([
  BLOCK_TYPES.commentStep,
  BLOCK_TYPES.scopedRuleCasesStep,
  BLOCK_TYPES.dropColumnsStep,
  BLOCK_TYPES.renameColumnStep,
  BLOCK_TYPES.deriveColumnStep,
  BLOCK_TYPES.filterRowsStep,
  BLOCK_TYPES.splitColumnStep,
  BLOCK_TYPES.combineColumnsStep,
  BLOCK_TYPES.deduplicateRowsStep,
  BLOCK_TYPES.sortRowsStep,
]);
const SCHEMA_AFFECTING_BLOCK_TYPES = new Set<string>([
  BLOCK_TYPES.scopedRuleCasesStep,
  BLOCK_TYPES.dropColumnsStep,
  BLOCK_TYPES.renameColumnStep,
  BLOCK_TYPES.deriveColumnStep,
  BLOCK_TYPES.filterRowsStep,
  BLOCK_TYPES.splitColumnStep,
  BLOCK_TYPES.combineColumnsStep,
  BLOCK_TYPES.deduplicateRowsStep,
  BLOCK_TYPES.sortRowsStep,
  BLOCK_TYPES.ruleCaseItem,
  BLOCK_TYPES.outputColumnItem,
  BLOCK_TYPES.sortItem,
]);
const ORDER_SENSITIVE_BLOCK_TYPES = new Set<string>([
  ...STEP_BLOCK_TYPES,
  BLOCK_TYPES.ruleCaseItem,
  BLOCK_TYPES.outputColumnItem,
  BLOCK_TYPES.sortItem,
]);
const SCHEMA_AFFECTING_CHANGE_DELAY_MS = 150;
const SEMANTIC_CHANGE_DELAY_MS = 1000;
const SCHEMA_PROJECTION_DELAY_MS = 700;

export function WorkflowEditor({ table, loadWorkflow, loadVersion, extraColumnIds, onWorkspaceChange }: WorkflowEditorProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const suppressChangesRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const idleCallbackRef = useRef<number | null>(null);
  const schemaDebounceTimerRef = useRef<number | null>(null);
  const schemaIdleCallbackRef = useRef<number | null>(null);
  const latestInputsRef = useRef<DeferredWorkspaceInputs>({
    table,
    extraColumnIds,
    onWorkspaceChange,
  });
  const [metadata, setMetadata] = useState<AuthoringWorkflowMetadata>(() => getDefaultMetadata(table, loadWorkflow));
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const isFullscreen = isFallbackFullscreen;

  latestInputsRef.current = {
    table,
    extraColumnIds,
    onWorkspaceChange,
  };

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

    const clearScheduledWork = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      if (idleCallbackRef.current !== null) {
        cancelDeferredIdleWork(idleCallbackRef.current);
        idleCallbackRef.current = null;
      }

      if (schemaDebounceTimerRef.current !== null) {
        window.clearTimeout(schemaDebounceTimerRef.current);
        schemaDebounceTimerRef.current = null;
      }

      if (schemaIdleCallbackRef.current !== null) {
        cancelDeferredIdleWork(schemaIdleCallbackRef.current);
        schemaIdleCallbackRef.current = null;
      }
    };

    const flushWorkspaceChange = (shouldProjectSchema: boolean) => {
      if (suppressChangesRef.current || workspace.isDragging()) {
        return;
      }

      const { table: currentTable, extraColumnIds: currentExtraColumnIds, onWorkspaceChange: handleWorkspaceChange } = latestInputsRef.current;
      const workflowResult = workspaceToWorkflow(workspace);
      const nextExtraColumnIds = workflowResult.workflow
        ? collectWorkflowColumnIds(workflowResult.workflow)
        : currentExtraColumnIds;

      handleWorkspaceChange(workflowResult);

      if (!shouldProjectSchema) {
        return;
      }

      schemaDebounceTimerRef.current = window.setTimeout(() => {
        schemaDebounceTimerRef.current = null;
        schemaIdleCallbackRef.current = scheduleDeferredIdleWork(() => {
          schemaIdleCallbackRef.current = null;
          syncEditorSchema(workspace, currentTable, nextExtraColumnIds);
        });
      }, SCHEMA_PROJECTION_DELAY_MS);
    };

    const handleWorkspaceChange = (event: Blockly.Events.Abstract) => {
      if (suppressChangesRef.current) {
        return;
      }

      if (event.isUiEvent) {
        return;
      }

      if (isSemanticNoOpMoveEvent(workspace, event)) {
        return;
      }

      if (workspace.isDragging()) {
        return;
      }

      clearScheduledWork();

      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        const shouldProjectSchema = shouldProjectSchemaForEvent(workspace, event);
        idleCallbackRef.current = scheduleDeferredIdleWork(() => {
          idleCallbackRef.current = null;
          flushWorkspaceChange(shouldProjectSchema);
        });
      }, shouldProjectSchemaForEvent(workspace, event) ? SCHEMA_AFFECTING_CHANGE_DELAY_MS : SEMANTIC_CHANGE_DELAY_MS);
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
      clearScheduledWork();
      workspace.dispose();
      workspaceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (workspaceRef.current) {
      syncEditorSchema(workspaceRef.current, table, extraColumnIds);
    }
  }, [table.schema.columns]);

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

function isSemanticNoOpMoveEvent(workspace: Blockly.Workspace, event: Blockly.Events.Abstract) {
  if (!(event instanceof Blockly.Events.BlockMove)) {
    return false;
  }

  const block = getEventBlock(workspace, event);

  if (block && ORDER_SENSITIVE_BLOCK_TYPES.has(block.type)) {
    return false;
  }

  return event.oldParentId === event.newParentId
    && event.oldInputName === event.newInputName
    && Boolean(event.oldCoordinate || event.newCoordinate);
}

function shouldProjectSchemaForEvent(workspace: Blockly.Workspace, event: Blockly.Events.Abstract) {
  if (event instanceof Blockly.Events.BlockCreate || event instanceof Blockly.Events.BlockDelete) {
    const block = getEventBlock(workspace, event);
    return !block || SCHEMA_AFFECTING_BLOCK_TYPES.has(block.type);
  }

  if (event instanceof Blockly.Events.BlockMove) {
    const block = getEventBlock(workspace, event);

    if (!block) {
      return true;
    }

    return SCHEMA_AFFECTING_BLOCK_TYPES.has(block.type);
  }

  if (event instanceof Blockly.Events.BlockChange) {
    const block = getEventBlock(workspace, event);

    if (!block) {
      return true;
    }

    if (block.type === BLOCK_TYPES.renameColumnStep) {
      return event.element === 'field' && (event.name === 'COLUMN_ID' || event.name === 'NEW_DISPLAY_NAME');
    }

    if (block.type === BLOCK_TYPES.dropColumnsStep) {
      return event.element === 'field' && event.name === 'COLUMN_IDS';
    }

    if (block.type === BLOCK_TYPES.deriveColumnStep) {
      return event.element === 'field'
        && (event.name === 'NEW_COLUMN_ID' || event.name === 'NEW_DISPLAY_NAME' || event.name === 'CREATE_MODE');
    }

    if (block.type === BLOCK_TYPES.splitColumnStep) {
      return event.element === 'field' && (event.name === 'COLUMN_ID' || event.name === 'DELIMITER');
    }

    if (block.type === BLOCK_TYPES.combineColumnsStep) {
      return event.element === 'field'
        && (event.name === 'COLUMN_IDS' || event.name === 'NEW_COLUMN_ID' || event.name === 'NEW_DISPLAY_NAME');
    }

    if (block.type === BLOCK_TYPES.outputColumnItem) {
      return event.element === 'field' && (event.name === 'COLUMN_ID' || event.name === 'DISPLAY_NAME');
    }
  }

  return false;
}

function getEventBlock(workspace: Blockly.Workspace, event: Blockly.Events.Abstract) {
  return 'blockId' in event && typeof event.blockId === 'string'
    ? workspace.getBlockById(event.blockId)
    : null;
}

function scheduleDeferredIdleWork(callback: () => void) {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(() => {
      callback();
    });
  }

  return window.setTimeout(callback, 0);
}

function cancelDeferredIdleWork(handle: number) {
  if (typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
    return;
  }

  window.clearTimeout(handle);
}
