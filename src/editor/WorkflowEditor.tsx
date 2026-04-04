import { type ButtonHTMLAttributes, type ChangeEvent, type MouseEvent, type MutableRefObject, type ReactNode, useEffect, useRef, useState } from 'react';

import * as Blockly from 'blockly';

import type { Table } from '../domain/model';
import type { Workflow } from '../workflow';

import type { AuthoringWorkflowMetadata } from './authoring';
import { BLOCK_TYPES, registerWorkflowBlocks } from './blocks';
import { shouldIgnoreSemanticMove } from './changeSemantics';
import {
  createWorkspacePromptSnapshot,
  createDefaultWorkflow,
  getWorkspaceMetadata,
  projectWorkspaceStepSchemas,
  setWorkspaceMetadata,
  workflowToWorkspace,
  workspaceToWorkflow,
} from './mapping';
import { collectWorkflowColumnIds, setEditorSchemaColumns } from './schemaOptions';
import {
  getSelectedWorkflowToolboxCategoryId,
  getWorkflowToolboxCategory,
  getWorkflowToolboxDefinition,
  registerWorkflowToolboxCategoryCallbacks,
} from './toolbox';
import type { EditorWorkspaceChange } from './types';
import { buildValidationDisplayItems } from './validationDisplay';

interface WorkflowEditorProps {
  table: Table;
  loadWorkflow: Workflow | null;
  loadVersion: number;
  extraColumnIds: string[];
  issues: Array<{ code: string; message: string }>;
  jsonError: string | null;
  canExportWorkflowJson: boolean;
  canUseAI: boolean;
  canRunWorkflow: boolean;
  onExportWorkflowJson: () => void;
  onOpenWorkflowImportDialog: () => void;
  onOpenAIDialog: () => void;
  onRunWorkflow: () => void;
  onWorkspaceChange: (result: EditorWorkspaceChange) => void;
}

interface DeferredWorkspaceInputs {
  table: Table;
  extraColumnIds: string[];
  onWorkspaceChange: (result: EditorWorkspaceChange) => void;
}

type ToolboxWithItemLookup = Blockly.IToolbox & {
  getSelectedItem(): Blockly.ISelectableToolboxItem | null;
  getToolboxItemById(id: string): Blockly.IToolboxItem | null;
  setSelectedItem(newItem: Blockly.IToolboxItem | null): void;
};

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
  BLOCK_TYPES.setValueActionItem,
  BLOCK_TYPES.highlightActionItem,
  BLOCK_TYPES.outputColumnItem,
  BLOCK_TYPES.sortItem,
]);
const ORDER_SENSITIVE_BLOCK_TYPES = new Set<string>([
  ...STEP_BLOCK_TYPES,
  BLOCK_TYPES.ruleCaseItem,
  BLOCK_TYPES.setValueActionItem,
  BLOCK_TYPES.highlightActionItem,
  BLOCK_TYPES.outputColumnItem,
  BLOCK_TYPES.sortItem,
]);
const SCHEMA_AFFECTING_CHANGE_DELAY_MS = 150;
const SEMANTIC_CHANGE_DELAY_MS = 1000;
const SCHEMA_PROJECTION_DELAY_MS = 700;
const TOOLBOX_ITEM_SELECT_EVENT = 'toolbox_item_select';
const TOOLBOX_SEARCH_RESTORE_WINDOW_MS = 250;

export function WorkflowEditor({
  table,
  loadWorkflow,
  loadVersion,
  extraColumnIds,
  issues,
  jsonError,
  canExportWorkflowJson,
  canUseAI,
  canRunWorkflow,
  onExportWorkflowJson,
  onOpenWorkflowImportDialog,
  onOpenAIDialog,
  onRunWorkflow,
  onWorkspaceChange,
}: WorkflowEditorProps) {
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
  const activeToolboxCategoryIdRef = useRef<string | null>(null);
  const lastToolboxSearchPointerDownAtRef = useRef(0);
  const toolboxSearchQueryRef = useRef('');
  const [metadata, setMetadata] = useState<AuthoringWorkflowMetadata>(() => getDefaultMetadata(table, loadWorkflow));
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const [activeToolboxCategoryId, setActiveToolboxCategoryId] = useState<string | null>(null);
  const [canDeleteSelection, setCanDeleteSelection] = useState(false);
  const [toolboxSearchQuery, setToolboxSearchQuery] = useState('');
  const isFullscreen = isFallbackFullscreen;
  const validationItems = buildValidationDisplayItems(issues, jsonError);
  const issueCount = validationItems.length;

  latestInputsRef.current = {
    table,
    extraColumnIds,
    onWorkspaceChange,
  };
  toolboxSearchQueryRef.current = toolboxSearchQuery;

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
        controls: false,
        wheel: true,
      },
      trashcan: false,
    });

    workspaceRef.current = workspace;
    registerWorkflowToolboxCategoryCallbacks(workspace, () => toolboxSearchQueryRef.current);

    const restoreActiveToolboxSelection = () => {
      const categoryId = activeToolboxCategoryIdRef.current;
      const toolbox = workspace.getToolbox() as ToolboxWithItemLookup | null;

      if (!categoryId || !toolbox || toolbox.getSelectedItem()) {
        return;
      }

      const toolboxItem = toolbox.getToolboxItemById(categoryId);

      if (toolboxItem) {
        toolbox.setSelectedItem(toolboxItem);
      }
    };

    const syncActiveToolboxCategory = (categoryId: string | null) => {
      if (activeToolboxCategoryIdRef.current === categoryId) {
        return;
      }

      activeToolboxCategoryIdRef.current = categoryId;
      toolboxSearchQueryRef.current = '';
      setActiveToolboxCategoryId(categoryId);
      setToolboxSearchQuery('');
    };

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
      const workflowResult = buildEditorWorkspaceChange(workspace);
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
      syncSelectionState();

      if (suppressChangesRef.current) {
        return;
      }

      if (event.type === TOOLBOX_ITEM_SELECT_EVENT) {
        const nextCategoryId = getWorkflowToolboxCategory((event as { newItem?: string }).newItem)
          ? (event as { newItem?: string }).newItem ?? null
          : getSelectedWorkflowToolboxCategoryId(workspace);

        if (nextCategoryId) {
          syncActiveToolboxCategory(nextCategoryId);
        } else {
          // Preserve the open flyout when focus moves to the external category search UI.
          const shouldRestoreFromSearchUi =
            performance.now() - lastToolboxSearchPointerDownAtRef.current <= TOOLBOX_SEARCH_RESTORE_WINDOW_MS;

          if (shouldRestoreFromSearchUi) {
            queueMicrotask(() => {
              restoreActiveToolboxSelection();
            });
          } else {
            syncActiveToolboxCategory(null);
          }
        }
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
    syncSelectionState();
    syncActiveToolboxCategory(getSelectedWorkflowToolboxCategoryId(workspace));
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

  useEffect(() => {
    const workspace = workspaceRef.current;

    if (!workspace || !activeToolboxCategoryId) {
      return;
    }

    workspace.refreshToolboxSelection();
  }, [activeToolboxCategoryId, toolboxSearchQuery]);

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
      onWorkspaceChange(buildEditorWorkspaceChange(workspace));
    };
  }

  function handleToolboxSearchPointerDown(event: MouseEvent<HTMLDivElement | HTMLInputElement>) {
    event.stopPropagation();
    lastToolboxSearchPointerDownAtRef.current = performance.now();

    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    const categoryId = activeToolboxCategoryIdRef.current;
    const toolbox = workspace.getToolbox() as ToolboxWithItemLookup | null;

    if (!categoryId || !toolbox || toolbox.getSelectedItem()) {
      return;
    }

    const toolboxItem = toolbox.getToolboxItemById(categoryId);

    if (toolboxItem) {
      toolbox.setSelectedItem(toolboxItem);
    }
  }

  function syncSelectionState() {
    const selected = Blockly.getSelected();

    setCanDeleteSelection(Boolean(selected && 'dispose' in selected && typeof selected.dispose === 'function'));
  }

  function handleZoom(amount: number) {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    workspace.zoomCenter(amount);
  }

  function handleResetZoom() {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    workspace.setScale(workspace.options.zoomOptions.startScale);
    workspace.scrollCenter();
  }

  function handleDeleteSelection() {
    const selected = Blockly.getSelected();

    if (!selected || !('dispose' in selected) || typeof selected.dispose !== 'function') {
      return;
    }

    selected.dispose(true, true);
    syncSelectionState();
  }

  const activeToolboxCategory = getWorkflowToolboxCategory(activeToolboxCategoryId);

  return (
    <div className={`workflow-editor-shell${isFallbackFullscreen ? ' workflow-editor-shell--fullscreen' : ''}`} ref={shellRef}>
      <div className="workflow-editor-header">
        <h2 className="workflow-editor-title">Workflow editor</h2>
        <div className="workflow-editor-toolbar">
          <div className="workflow-editor-actions">
            <WorkflowEditorButton disabled={!canExportWorkflowJson} icon={<ExportIcon />} onClick={onExportWorkflowJson} type="button">
              Export workflow JSON
            </WorkflowEditorButton>
            <WorkflowEditorButton icon={<ImportIcon />} onClick={onOpenWorkflowImportDialog} type="button">
              Import workflow JSON
            </WorkflowEditorButton>
            <WorkflowEditorButton disabled={!canUseAI} icon={<SparklesIcon />} onClick={onOpenAIDialog} type="button">
              Ask AI
            </WorkflowEditorButton>
            <WorkflowEditorButton disabled={!canRunWorkflow} icon={<PlayIcon />} onClick={onRunWorkflow} type="button" variant="primary">
              Run workflow
            </WorkflowEditorButton>
          </div>
          <div className="workflow-editor-controls">
            <WorkflowEditorButton icon={<ZoomInIcon />} onClick={() => handleZoom(1)} type="button">
              Zoom in
            </WorkflowEditorButton>
            <WorkflowEditorButton icon={<ResetIcon />} onClick={handleResetZoom} type="button">
              Reset view
            </WorkflowEditorButton>
            <WorkflowEditorButton icon={<ZoomOutIcon />} onClick={() => handleZoom(-1)} type="button">
              Zoom out
            </WorkflowEditorButton>
            <WorkflowEditorButton disabled={!canDeleteSelection} icon={<TrashIcon />} onClick={handleDeleteSelection} type="button">
              Delete selected
            </WorkflowEditorButton>
            <WorkflowEditorButton
              aria-label={isFullscreen ? 'Exit fullscreen editor' : 'Open fullscreen editor'}
              icon={isFullscreen ? <CollapseIcon /> : <FullscreenIcon />}
              onClick={() => {
                void handleToggleFullscreen();
              }}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              type="button"
            >
              {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            </WorkflowEditorButton>
          </div>
        </div>
      </div>
      <div className="workflow-editor-topbar">
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
      </div>
      {activeToolboxCategory ? (
        <div className="workflow-editor-toolbox-search" onMouseDown={handleToolboxSearchPointerDown}>
          <span className="workflow-editor-toolbox-search__label">{activeToolboxCategory.name}</span>
          <input
            className="workflow-editor-toolbox-search__input"
            onChange={(event) => setToolboxSearchQuery(event.target.value)}
            onMouseDown={handleToolboxSearchPointerDown}
            placeholder={`Search ${activeToolboxCategory.name}`}
            type="search"
            value={toolboxSearchQuery}
          />
        </div>
      ) : null}
      <div className="workflow-editor-canvas" ref={containerRef} />
      <section className="workflow-editor-validation">
        <div className="panel-header panel-header--compact">
          <h2>Validation</h2>
          <p>{issueCount === 0 ? 'No issues' : `${issueCount} issue${issueCount === 1 ? '' : 's'}`}</p>
        </div>
        {validationItems.length === 0 ? (
          <div className="empty-panel empty-panel--compact">No current workflow issues.</div>
        ) : (
          <div className="panel-scroll-region workflow-editor-validation__body">
            <ul className="issue-list issue-list--compact">
              {validationItems.map((issue, index) => (
                <li className="issue-item issue-item--compact" key={`${issue.code}-${index}`}>
                  <strong>{issue.code}</strong>
                  <p>{issue.message}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function loadWorkspace(
  workspace: Blockly.Workspace,
  table: Table,
  workflow: Workflow,
  onWorkspaceChange: (result: EditorWorkspaceChange) => void,
  suppressChangesRef: MutableRefObject<boolean>,
) {
  suppressChangesRef.current = true;
  setEditorSchemaColumns(table.schema.columns, collectWorkflowColumnIds(workflow));
  workflowToWorkspace(workspace, workflow);
  suppressChangesRef.current = false;
  onWorkspaceChange(buildEditorWorkspaceChange(workspace));
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

function buildEditorWorkspaceChange(workspace: Blockly.Workspace): EditorWorkspaceChange {
  return {
    ...workspaceToWorkflow(workspace),
    workspacePromptSnapshot: createWorkspacePromptSnapshot(workspace),
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

  return shouldIgnoreSemanticMove({
    blockType: block?.type ?? null,
    isOrderSensitive: block ? ORDER_SENSITIVE_BLOCK_TYPES.has(block.type) : false,
    isStepBlockType: block ? isStepBlockType(block.type) : false,
    hasParent: Boolean(block?.getParent()),
    oldParentId: event.oldParentId,
    newParentId: event.newParentId,
    oldInputName: event.oldInputName,
    newInputName: event.newInputName,
    oldCoordinate: event.oldCoordinate,
    newCoordinate: event.newCoordinate,
  });
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

interface WorkflowEditorButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  variant?: 'default' | 'primary';
}

function WorkflowEditorButton({ children, className = '', icon, variant = 'default', ...props }: WorkflowEditorButtonProps) {
  const variantClassName = variant === 'primary' ? ' workflow-editor-button--primary' : '';
  const nextClassName = `workflow-editor-button${variantClassName}${className ? ` ${className}` : ''}`;

  return (
    <button {...props} className={nextClassName}>
      <span aria-hidden="true" className="workflow-editor-button__icon">
        {icon}
      </span>
      <span>{children}</span>
    </button>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 4v10" />
      <path d="m8 8 4-4 4 4" />
      <path d="M5 14v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 20V10" />
      <path d="m8 16 4 4 4-4" />
      <path d="M5 10V6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v4" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
      <path d="m18.5 15 0.8 2.2 2.2 0.8-2.2 0.8-0.8 2.2-0.8-2.2-2.2-0.8 2.2-0.8 0.8-2.2Z" />
      <path d="m5.5 14 0.6 1.6 1.6 0.6-1.6 0.6-0.6 1.6-0.6-1.6-1.6-0.6 1.6-0.6 0.6-1.6Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M8 6v12l10-6Z" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  );
}

function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
      <path d="M8 11h6" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 12a8 8 0 1 0 2.3-5.7" />
      <path d="M4 4v4h4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M7 7v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M8 4H4v4" />
      <path d="M16 4h4v4" />
      <path d="M20 16v4h-4" />
      <path d="M4 16v4h4" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M9 9H4V4" />
      <path d="M15 9h5V4" />
      <path d="M20 20h-5v-5" />
      <path d="M4 20h5v-5" />
    </svg>
  );
}

function cancelDeferredIdleWork(handle: number) {
  if (typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
    return;
  }

  window.clearTimeout(handle);
}
