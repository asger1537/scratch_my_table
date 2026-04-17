import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

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
import { refreshWorkspaceSchemaFields } from './schemaFieldRefresh';
import type { EditorWorkspaceChange, ValidationDisplayItem } from './types';
import { buildValidationDisplayItems } from './validationDisplay';

interface WorkflowEditorProps {
  table: Table;
  loadWorkflow: Workflow | null;
  loadWorkflowState: Record<string, unknown> | null;
  loadMetadata: AuthoringWorkflowMetadata;
  loadVersion: number;
  extraColumnIds: string[];
  issues: ValidationDisplayItem[];
  jsonError: string | null;
  workflowTabs?: ReactNode;
  canExportWorkflows: boolean;
  canUseAI: boolean;
  canRunWorkflow: boolean;
  canRunSequence: boolean;
  onExportWorkflows: () => void;
  onOpenWorkflowImportDialog: () => void;
  onOpenAIDialog: () => void;
  onRunWorkflow: () => void;
  onRunSequence: () => void;
  onOpenRunOrderDialog: () => void;
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
  BLOCK_TYPES.scopedRuleSingleStep,
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
  BLOCK_TYPES.scopedRuleSingleStep,
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
const TOOLBOX_ITEM_SELECT_EVENT = 'toolbox_item_select';
const TOOLBOX_SEARCH_RESTORE_WINDOW_MS = 250;
const WORKSPACE_ZOOM_SCALE_SPEED = 1.08;
const GO_TO_BLOCK_PADDING_PX = 32;

export interface WorkflowEditorHandle {
  flushWorkspaceChange: () => void;
}

export const WorkflowEditor = forwardRef<WorkflowEditorHandle, WorkflowEditorProps>(function WorkflowEditor({
  table,
  loadWorkflow,
  loadWorkflowState,
  loadMetadata,
  loadVersion,
  extraColumnIds,
  issues,
  jsonError,
  workflowTabs,
  canExportWorkflows,
  canUseAI,
  canRunWorkflow,
  canRunSequence,
  onExportWorkflows,
  onOpenWorkflowImportDialog,
  onOpenAIDialog,
  onRunWorkflow,
  onRunSequence,
  onOpenRunOrderDialog,
  onWorkspaceChange,
}: WorkflowEditorProps, ref) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<Blockly.WorkspaceSvg | null>(null);
  const suppressChangesRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);
  const idleCallbackRef = useRef<number | null>(null);
  const clearScheduledWorkRef = useRef<() => void>(() => {});
  const flushWorkspaceChangeRef = useRef<(shouldProjectSchema: boolean) => void>(() => {});
  const latestInputsRef = useRef<DeferredWorkspaceInputs>({
    table,
    extraColumnIds,
    onWorkspaceChange,
  });
  const activeToolboxCategoryIdRef = useRef<string | null>(null);
  const lastToolboxSearchPointerDownAtRef = useRef(0);
  const toolboxSearchQueryRef = useRef('');
  const [metadata, setMetadata] = useState<AuthoringWorkflowMetadata>(() => getDefaultMetadata(table, loadWorkflow, loadMetadata));
  const [isFallbackFullscreen, setIsFallbackFullscreen] = useState(false);
  const [activeToolboxCategoryId, setActiveToolboxCategoryId] = useState<string | null>(null);
  const [canDeleteSelection, setCanDeleteSelection] = useState(false);
  const [canDeleteAll, setCanDeleteAll] = useState(false);
  const [toolboxSearchQuery, setToolboxSearchQuery] = useState('');
  const isFullscreen = isFallbackFullscreen;
  const validationItems = buildValidationDisplayItems(issues, jsonError);
  const issueCount = validationItems.length;
  const previousIssueCountRef = useRef(issueCount);
  const [isValidationCollapsed, setIsValidationCollapsed] = useState(issueCount === 0);

  latestInputsRef.current = {
    table,
    extraColumnIds,
    onWorkspaceChange,
  };
  toolboxSearchQueryRef.current = toolboxSearchQuery;

  useImperativeHandle(ref, () => ({
    flushWorkspaceChange: () => {
      clearScheduledWorkRef.current();
      flushWorkspaceChangeRef.current(true);
    },
  }), []);

  const handleGoToIssue = (targetBlockId: string) => {
    const workspace = workspaceRef.current;

    if (!workspace) {
      return;
    }

    goToBlockInWorkspace(workspace, targetBlockId);
  };

  useEffect(() => {
    const previousIssueCount = previousIssueCountRef.current;

    if (issueCount === 0) {
      setIsValidationCollapsed(true);
    } else if (previousIssueCount === 0) {
      setIsValidationCollapsed(false);
    }

    previousIssueCountRef.current = issueCount;
  }, [issueCount]);

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
        scaleSpeed: WORKSPACE_ZOOM_SCALE_SPEED,
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

    };
    clearScheduledWorkRef.current = clearScheduledWork;

    const flushWorkspaceChange = (shouldProjectSchema: boolean) => {
      if (suppressChangesRef.current || workspace.isDragging()) {
        return;
      }

      const { table: currentTable, extraColumnIds: currentExtraColumnIds, onWorkspaceChange: handleWorkspaceChange } = latestInputsRef.current;
      let workflowResult = buildEditorWorkspaceChange(workspace);
      const nextExtraColumnIds = workflowResult.workflow
        ? collectWorkflowColumnIds(workflowResult.workflow)
        : currentExtraColumnIds;

      if (shouldProjectSchema) {
        syncEditorSchema(workspace, currentTable, nextExtraColumnIds);
        workflowResult = buildEditorWorkspaceChange(workspace);
      }

      handleWorkspaceChange(workflowResult);
    };
    flushWorkspaceChangeRef.current = flushWorkspaceChange;

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

    loadWorkspace(
      workspace,
      table,
      loadWorkflow ?? createDefaultWorkflow(table),
      extraColumnIds,
      loadWorkflowState,
      loadMetadata,
      onWorkspaceChange,
      suppressChangesRef,
    );
    setMetadata(getWorkspaceMetadata(workspace));
    syncSelectionState();
    syncActiveToolboxCategory(getSelectedWorkflowToolboxCategoryId(workspace));
    resizeWorkspace(workspace, true);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearScheduledWork();
      clearScheduledWorkRef.current = () => {};
      flushWorkspaceChangeRef.current = () => {};
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

    loadWorkspace(
      workspace,
      table,
      loadWorkflow ?? createDefaultWorkflow(table),
      extraColumnIds,
      loadWorkflowState,
      loadMetadata,
      onWorkspaceChange,
      suppressChangesRef,
    );
    setMetadata(getWorkspaceMetadata(workspace));
    syncSelectionState();
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

  function flushPendingWorkspaceChange(shouldProjectSchema = true) {
    clearScheduledWorkRef.current();
    flushWorkspaceChangeRef.current(shouldProjectSchema);
  }

  function handleRunWorkflowAction() {
    flushPendingWorkspaceChange();

    if (!isFullscreen) {
      onRunWorkflow();
      return;
    }

    setIsFallbackFullscreen(false);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        onRunWorkflow();
      });
    });
  }

  function handleRunSequenceAction() {
    flushPendingWorkspaceChange();

    if (!isFullscreen) {
      onRunSequence();
      return;
    }

    setIsFallbackFullscreen(false);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        onRunSequence();
      });
    });
  }

  function handleMetadataChange(field: keyof Pick<AuthoringWorkflowMetadata, 'description'>) {
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
    setCanDeleteAll(Boolean(workspaceRef.current && workspaceRef.current.getAllBlocks(false).length > 0));
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

  function handleDeleteAll() {
    const workspace = workspaceRef.current;

    if (!workspace || workspace.getAllBlocks(false).length === 0) {
      return;
    }

    workspace.clear();
    syncSelectionState();
  }

  const activeToolboxCategory = getWorkflowToolboxCategory(activeToolboxCategoryId);
  const activeToolboxCategoryName = activeToolboxCategory?.name ?? 'Blocks';

  return (
    <div className={`workflow-editor-shell${isFallbackFullscreen ? ' workflow-editor-shell--fullscreen' : ''}`} ref={shellRef}>
      <div className="workflow-editor-header">
        <div className="workflow-editor-header-main">
          <h2 className="workflow-editor-title">Workflow editor</h2>
          <div className="workflow-editor-actions workflow-editor-actions--primary">
            <WorkflowEditorButton
              disabled={!canUseAI}
              icon={<SparklesIcon />}
              onClick={() => {
                flushPendingWorkspaceChange(false);
                onOpenAIDialog();
              }}
              type="button"
            >
              Ask AI
            </WorkflowEditorButton>
            <WorkflowEditorButton disabled={!canRunWorkflow} icon={<PlayIcon />} onClick={handleRunWorkflowAction} type="button" variant="primary">
              Run workflow
            </WorkflowEditorButton>
            <WorkflowEditorButton disabled={!canRunSequence} icon={<SequenceIcon />} onClick={handleRunSequenceAction} type="button">
              Run sequence
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
        <div className="workflow-editor-header-secondary">
          <div className="workflow-editor-actions workflow-editor-actions--secondary">
            <WorkflowEditorButton
              disabled={!canExportWorkflows}
              icon={<ExportIcon />}
              onClick={() => {
                flushPendingWorkspaceChange(false);
                onExportWorkflows();
              }}
              type="button"
            >
              Export workflow(s)
            </WorkflowEditorButton>
            <WorkflowEditorButton
              icon={<ImportIcon />}
              onClick={() => {
                flushPendingWorkspaceChange(false);
                onOpenWorkflowImportDialog();
              }}
              type="button"
            >
              Import workflow(s)
            </WorkflowEditorButton>
          </div>
          <div className="workflow-editor-controls">
            <WorkflowEditorButton
              icon={<RunOrderIcon />}
              onClick={() => {
                flushPendingWorkspaceChange(false);
                onOpenRunOrderDialog();
              }}
              type="button"
            >
              Run order
            </WorkflowEditorButton>
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
            <WorkflowEditorButton disabled={!canDeleteAll} icon={<TrashAllIcon />} onClick={handleDeleteAll} type="button">
              Delete all
            </WorkflowEditorButton>
          </div>
        </div>
      </div>
      <div className="workflow-editor-topbar">
        <div className="workflow-editor-metadata">
          <label className="workflow-meta-field workflow-meta-field--wide">
            <span>Description</span>
            <textarea onChange={handleMetadataChange('description')} rows={1} value={metadata.description ?? ''} />
          </label>
        </div>
      </div>
      {workflowTabs ? <div className="workflow-editor-tabs">{workflowTabs}</div> : null}
      <div
        aria-hidden={activeToolboxCategory ? undefined : true}
        className={`workflow-editor-toolbox-search${activeToolboxCategory ? '' : ' workflow-editor-toolbox-search--inactive'}`}
        onMouseDown={activeToolboxCategory ? handleToolboxSearchPointerDown : undefined}
      >
        <span className="workflow-editor-toolbox-search__label">{activeToolboxCategoryName}</span>
        <input
          className="workflow-editor-toolbox-search__input"
          disabled={!activeToolboxCategory}
          onChange={(event) => setToolboxSearchQuery(event.target.value)}
          onMouseDown={activeToolboxCategory ? handleToolboxSearchPointerDown : undefined}
          placeholder={`Search ${activeToolboxCategoryName}`}
          tabIndex={activeToolboxCategory ? undefined : -1}
          type="search"
          value={activeToolboxCategory ? toolboxSearchQuery : ''}
        />
      </div>
      <div className="workflow-editor-canvas" ref={containerRef} />
      <section className={`workflow-editor-validation${isValidationCollapsed ? ' workflow-editor-validation--collapsed' : ''}`}>
        <h2 className="workflow-editor-validation__heading">
          <button
            aria-expanded={!isValidationCollapsed}
            className="workflow-editor-validation__toggle"
            onClick={() => setIsValidationCollapsed((current) => !current)}
            type="button"
          >
            <span className="workflow-editor-validation__title">
              <span>Validation</span>
              <span
                className={`workflow-editor-validation__badge ${issueCount === 0
                  ? 'workflow-editor-validation__badge--clear'
                  : 'workflow-editor-validation__badge--warning'}`}
              >
                {issueCount === 0 ? 'No issues' : `${issueCount} issue${issueCount === 1 ? '' : 's'}`}
              </span>
            </span>
            <span aria-hidden="true" className="workflow-editor-validation__toggle-icon">
              <ChevronDownIcon />
            </span>
          </button>
        </h2>
        {isValidationCollapsed ? null : validationItems.length === 0 ? (
          <div className="empty-panel empty-panel--compact">No current workflow issues.</div>
        ) : (
          <div className="panel-scroll-region workflow-editor-validation__body">
            <ul className="issue-list issue-list--compact">
              {validationItems.map((issue, index) => (
                <ValidationIssueListItem
                  issue={issue}
                  key={`${issue.code}-${index}`}
                  onGoToIssue={handleGoToIssue}
                />
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
});

function loadWorkspace(
  workspace: Blockly.Workspace,
  table: Table,
  workflow: Workflow,
  extraColumnIds: string[],
  workspaceState: Record<string, unknown> | null,
  metadata: AuthoringWorkflowMetadata,
  onWorkspaceChange: (result: EditorWorkspaceChange) => void,
  suppressChangesRef: MutableRefObject<boolean>,
) {
  suppressChangesRef.current = true;
  setEditorSchemaColumns(table.schema.columns, extraColumnIds);
  workspace.clear();

  if (workspaceState) {
    Blockly.serialization.workspaces.load(workspaceState, workspace);
    setWorkspaceMetadata(workspace, metadata);
  } else {
    workflowToWorkspace(workspace, workflow);
  }

  syncEditorSchema(workspace, table, extraColumnIds);
  suppressChangesRef.current = false;
  onWorkspaceChange(buildEditorWorkspaceChange(workspace));
}

function syncEditorSchema(workspace: Blockly.Workspace, table: Table, extraColumnIds: string[]) {
  setEditorSchemaColumns(table.schema.columns, extraColumnIds, projectWorkspaceStepSchemas(workspace, table));
  refreshWorkspaceSchemaFields(workspace);
}

function focusPrimaryStep(workspace: Blockly.Workspace) {
  const root = workspace.getTopBlocks(true).find((block) => isStepBlockType(block.type));

  if (!root) {
    return;
  }

  centerBlockInWorkspace(workspace, root.id);
}

function resizeWorkspace(workspace: Blockly.WorkspaceSvg, focusRoot = false) {
  requestAnimationFrame(() => {
    Blockly.svgResize(workspace);

    if (focusRoot) {
      focusPrimaryStep(workspace);
    }
  });
}

function getDefaultMetadata(table: Table, workflow: Workflow | null, metadata?: AuthoringWorkflowMetadata): AuthoringWorkflowMetadata {
  if (metadata) {
    return metadata;
  }

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
    metadata: getWorkspaceMetadata(workspace),
    workspaceState: Blockly.serialization.workspaces.save(workspace) as Record<string, unknown>,
    workspacePromptSnapshot: createWorkspacePromptSnapshot(workspace),
  };
}

function ValidationIssueListItem({
  issue,
  onGoToIssue,
}: {
  issue: ValidationDisplayItem;
  onGoToIssue: (targetBlockId: string) => void;
}) {
  const targetBlockId = issue.targetBlockId;

  return (
    <li className="issue-item issue-item--compact">
      <strong>{issue.code}</strong>
      <p>{issue.message}</p>
      {targetBlockId ? (
        <div className="issue-item__actions">
          <button
            className="issue-item__action"
            onClick={() => onGoToIssue(targetBlockId)}
            type="button"
          >
            Go to error
          </button>
        </div>
      ) : null}
    </li>
  );
}

function centerBlockInWorkspace(workspace: Blockly.Workspace, blockId: string) {
  const block = workspace.getBlockById(blockId);

  if (!block) {
    return;
  }

  if ('scrollBoundsIntoView' in workspace && 'getBoundingRectangle' in block) {
    (workspace as Blockly.WorkspaceSvg).scrollBoundsIntoView(
      (block as Blockly.BlockSvg).getBoundingRectangle(),
      GO_TO_BLOCK_PADDING_PX,
    );
    return;
  }

  if ('centerOnBlock' in workspace) {
    (workspace as Blockly.WorkspaceSvg).centerOnBlock(block.id, true);
  }
}

function goToBlockInWorkspace(workspace: Blockly.Workspace, blockId: string) {
  const block = workspace.getBlockById(blockId);

  if (!block) {
    return;
  }

  centerBlockInWorkspace(workspace, blockId);

  if ('select' in block && typeof block.select === 'function') {
    block.select();
  }
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
  const userOnMouseDown = props.onMouseDown;

  return (
    <button
      {...props}
      className={nextClassName}
      onMouseDown={(event) => {
        userOnMouseDown?.(event);

        if (!event.defaultPrevented) {
          event.preventDefault();
        }
      }}
    >
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

function SequenceIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M5 7h9" />
      <path d="m11 4 3 3-3 3" />
      <path d="M5 17h14" />
      <path d="m16 14 3 3-3 3" />
    </svg>
  );
}

function RunOrderIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M8 6h11" />
      <path d="M8 12h11" />
      <path d="M8 18h11" />
      <path d="M4 6h0.01" />
      <path d="M4 12h0.01" />
      <path d="M4 18h0.01" />
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

function TrashAllIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M7 7v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
      <path d="M4 10h2" />
      <path d="M4 14h2" />
      <path d="M4 18h2" />
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

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
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
