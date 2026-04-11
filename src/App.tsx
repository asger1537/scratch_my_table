import { ChangeEvent, DragEvent, startTransition, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_OPTIONS,
  appendAIDevLog,
  buildDraftPreviewWorkflow,
  buildGeminiRequestExport,
  formatDraftStepsForDebug,
  mapWorkflowValidationIssueToAIDraftIssue,
  normalizeGeminiModelSelection,
  replaceWorkflowSteps,
  runGeminiDraftTurn,
  applyWorkflowSetDraftToPackage,
  type AIDraftIssue,
  type AIDebugTrace,
  type AIDraft,
  type AIMessage,
  type AIProgressEvent,
  type AISettings,
  type GeminiClientLogEvent,
  type GeminiRequestExport,
} from './ai';
import {
  WorkflowBlockPreview,
  WorkflowEditor,
  type WorkflowEditorHandle,
  type AuthoringWorkflowMetadata,
  collectWorkflowColumnIds,
  createDefaultWorkflow,
  type EditorWorkspaceChange,
  type EditorIssue,
  type StepBlockIdsByStepId,
  type ValidationDisplayItem,
} from './editor';
import { executeWorkflow, type Workflow, type WorkflowExecutionResult, type WorkflowValidationIssue } from './workflow';
import { createValidationWorkerTableSnapshot, validateWorkflowWithWorker } from './workflow/validationWorkerClient';
import { getWorkflowInputTableForRunOrder, validateWorkflowPackageWithWorker } from './workflowPackageValidation';
import { getActiveTable, getCellStyle, getOrderedRows, getReadableTextColor, setActiveTable, type ImportWarning, type Table, type Workbook } from './domain/model';
import {
  buildCsvExportFileName,
  buildXlsxExportFileName,
  exportTableCsvBlob,
  exportTableXlsxBlob,
  importWorkbookFromFile,
} from './domain/workbookIO';
import {
  addWorkflowToPackage,
  buildExportWorkflowPackage,
  createWorkflowPackage,
  createNewPackageWorkflow,
  createSingleWorkflowPackage,
  deleteWorkflowFromPackage,
  flattenWorkflowSequence,
  mergeWorkflowPackages,
  parseWorkflowPackageJson,
  renameWorkflowInPackage,
  setActiveWorkflowInPackage,
  setRunOrderInPackage,
  updateWorkflowDescriptionInPackage,
  type WorkflowPackageV1,
  workflowPackageToJson,
} from './workflowPackage';

const PREVIEW_ROW_LIMIT = 50;
const COLLAPSIBLE_PANEL_MAX_HEIGHT_PX = 320;
const GEMINI_API_KEY_STORAGE_KEY = 'scratch_my_table.gemini_api_key';
const GEMINI_MODEL_STORAGE_KEY = 'scratch_my_table.gemini_model';
const GEMINI_THINKING_ENABLED_STORAGE_KEY = 'scratch_my_table.gemini_thinking_enabled';

type WorkflowImportMode = 'choice' | 'paste' | 'decision';

interface WorkflowAIState {
  messages: AIMessage[];
  promptValue: string;
  lastPromptRequestExport: GeminiRequestExport | null;
  draft: AIDraft | null;
  draftIssues: AIDraftIssue[];
  debugTrace: AIDebugTrace | null;
  progressEvents: AIProgressEvent[];
  error: string | null;
  isLoading: boolean;
}

interface WorkflowTabRuntimeState {
  editorIssues: EditorIssue[];
  validationIssues: WorkflowValidationIssue[];
  stepBlockIdsByStepId: StepBlockIdsByStepId;
  workspacePromptSnapshot: string;
  workspaceState: Record<string, unknown> | null;
  aiState: WorkflowAIState;
}

interface RunExecutionContext {
  kind: 'workflow' | 'sequence';
  workflowIds: string[];
  workflowNames: string[];
}

function createEmptyAIState(): WorkflowAIState {
  return {
    messages: [],
    promptValue: '',
    lastPromptRequestExport: null,
    draft: null,
    draftIssues: [],
    debugTrace: null,
    progressEvents: [],
    error: null,
    isLoading: false,
  };
}

function createWorkflowTabRuntimeState(): WorkflowTabRuntimeState {
  return {
    editorIssues: [],
    validationIssues: [],
    stepBlockIdsByStepId: {},
    workspacePromptSnapshot: '',
    workspaceState: null,
    aiState: createEmptyAIState(),
  };
}

function createWorkflowTabStates(workflows: Workflow[]): Record<string, WorkflowTabRuntimeState> {
  return Object.fromEntries(workflows.map((workflow) => [workflow.workflowId, createWorkflowTabRuntimeState()]));
}

function getWorkflowTabState(tabStates: Record<string, WorkflowTabRuntimeState>, workflowId: string): WorkflowTabRuntimeState {
  return tabStates[workflowId] ?? createWorkflowTabRuntimeState();
}

function getWorkflowById(workflowPackage: WorkflowPackageV1 | null, workflowId: string | null): Workflow | null {
  if (!workflowPackage || !workflowId) {
    return null;
  }

  return workflowPackage.workflows.find((workflow) => workflow.workflowId === workflowId) ?? null;
}

function getWorkflowRunContextWorkflowIds(workflowPackage: WorkflowPackageV1 | null, workflowId: string | null) {
  if (!workflowPackage || !workflowId) {
    return [];
  }

  const workflowIds = new Set(workflowPackage.workflows.map((workflow) => workflow.workflowId));
  const runOrderIndex = workflowPackage.runOrderWorkflowIds.indexOf(workflowId);

  if (runOrderIndex <= 0) {
    return workflowIds.has(workflowId) ? [workflowId] : [];
  }

  return workflowPackage.runOrderWorkflowIds
    .slice(0, runOrderIndex + 1)
    .filter((orderedWorkflowId, index, orderedWorkflowIds) =>
      workflowIds.has(orderedWorkflowId) && orderedWorkflowIds.indexOf(orderedWorkflowId) === index);
}

function getAIDraftStepCount(draft: AIDraft) {
  return draft.kind === 'workflowSet'
    ? draft.workflows.reduce((count, workflow) => count + workflow.steps.length, 0)
    : draft.steps.length;
}

function formatAIDraftSummary(draft: AIDraft) {
  if (draft.kind === 'workflowSet') {
    const stepCount = getAIDraftStepCount(draft);
    return `${draft.workflows.length} workflow${draft.workflows.length === 1 ? '' : 's'} with ${stepCount} total draft step${stepCount === 1 ? '' : 's'}`;
  }

  return `${draft.steps.length} draft step${draft.steps.length === 1 ? '' : 's'}`;
}

function formatWorkflowSetApplyMode(applyMode: Extract<AIDraft, { kind: 'workflowSet' }>['applyMode']) {
  switch (applyMode) {
    case 'append':
      return 'append generated workflows';
    case 'replaceActive':
      return 'replace active workflow';
    case 'replacePackage':
      return 'replace package';
  }
}

function formatWorkflowSetRunOrder(draft: Extract<AIDraft, { kind: 'workflowSet' }>) {
  const workflowNameById = new Map(draft.workflows.map((workflow) => [workflow.workflowId, workflow.name] as const));

  return draft.runOrderWorkflowIds
    .map((workflowId) => workflowNameById.get(workflowId) ?? workflowId)
    .join(' -> ');
}

function getWorkflowMetadata(workflow: Workflow | null): AuthoringWorkflowMetadata {
  if (!workflow) {
    return {
      workflowId: 'wf_workflow',
      name: 'Workflow',
      description: '',
    };
  }

  return {
    workflowId: workflow.workflowId,
    name: workflow.name,
    description: workflow.description,
  };
}

function replaceWorkflowInPackage(workflowPackage: WorkflowPackageV1, workflowId: string, nextWorkflow: Workflow): WorkflowPackageV1 {
  return createWorkflowPackage(
    workflowPackage.workflows.map((workflow) => (workflow.workflowId === workflowId ? nextWorkflow : workflow)),
    workflowPackage.activeWorkflowId,
    workflowPackage.runOrderWorkflowIds,
  );
}

function buildWorkflowPackageExportFileName(workflowPackage: WorkflowPackageV1) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = workflowPackage.workflows.length === 1
    ? workflowPackage.workflows[0].workflowId
    : workflowPackage.activeWorkflowId || 'workflow-package';

  return `${baseName || 'workflow-package'}-${timestamp}.json`;
}

export default function App() {
  const uploadDragDepthRef = useRef(0);
  const editorRef = useRef<WorkflowEditorHandle | null>(null);
  const workflowImportInputRef = useRef<HTMLInputElement | null>(null);
  const workflowImportDragDepthRef = useRef(0);
  const validationDebounceTimerRef = useRef<number | null>(null);
  const validationRequestIdRef = useRef(0);
  const runResultSectionRef = useRef<HTMLElement | null>(null);
  const pendingRunResultScrollRef = useRef(false);
  const [workbook, setWorkbookState] = useState<Workbook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploadDragActive, setIsUploadDragActive] = useState(false);
  const [workflowPackage, setWorkflowPackage] = useState<WorkflowPackageV1 | null>(null);
  const [workflowTabStates, setWorkflowTabStates] = useState<Record<string, WorkflowTabRuntimeState>>({});
  const [startRenameWorkflowId, setStartRenameWorkflowId] = useState<string | null>(null);
  const [workflowLoadVersion, setWorkflowLoadVersion] = useState(0);
  const [workflowJsonError, setWorkflowJsonError] = useState<string | null>(null);
  const [isWorkflowImportDialogOpen, setIsWorkflowImportDialogOpen] = useState(false);
  const [workflowImportMode, setWorkflowImportMode] = useState<WorkflowImportMode>('choice');
  const [workflowImportPasteValue, setWorkflowImportPasteValue] = useState('');
  const [isWorkflowImportDragActive, setIsWorkflowImportDragActive] = useState(false);
  const [pendingImportedWorkflowPackage, setPendingImportedWorkflowPackage] = useState<WorkflowPackageV1 | null>(null);
  const [isWorkflowExportDialogOpen, setIsWorkflowExportDialogOpen] = useState(false);
  const [isRunOrderDialogOpen, setIsRunOrderDialogOpen] = useState(false);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);
  const [lastRunContext, setLastRunContext] = useState<RunExecutionContext | null>(null);
  const [isAIDialogOpen, setIsAIDialogOpen] = useState(false);
  const [aiSettings, setAISettings] = useState<AISettings>(() => ({
    apiKey: readStoredValue(GEMINI_API_KEY_STORAGE_KEY),
    model: normalizeGeminiModelSelection(readStoredValue(GEMINI_MODEL_STORAGE_KEY) || DEFAULT_GEMINI_MODEL),
    thinkingEnabled: readStoredBoolean(GEMINI_THINKING_ENABLED_STORAGE_KEY),
  }));

  const activeTable = getActiveTable(workbook);
  const previewRows = activeTable ? getOrderedRows(activeTable).slice(0, PREVIEW_ROW_LIMIT) : [];
  const resultTable = executionResult?.transformedTable ?? null;
  const resultPreviewRows = resultTable ? getOrderedRows(resultTable).slice(0, PREVIEW_ROW_LIMIT) : [];
  const selectedAIModel = normalizeGeminiModelSelection(aiSettings.model);
  const activeWorkflowId = workflowPackage?.activeWorkflowId ?? null;
  const activeWorkflow = getWorkflowById(workflowPackage, activeWorkflowId);
  const activeWorkflowRunContextWorkflowIds = useMemo(
    () => getWorkflowRunContextWorkflowIds(workflowPackage, activeWorkflowId),
    [activeWorkflowId, workflowPackage],
  );
  const activeWorkflowInputTable = useMemo(
    () =>
      activeTable && workflowPackage && activeWorkflowId
        ? getWorkflowInputTableForRunOrder(workflowPackage, activeWorkflowId, activeTable)
        : activeTable,
    [activeTable, activeWorkflowId, workflowPackage],
  );
  const activeTabState = activeWorkflowId ? getWorkflowTabState(workflowTabStates, activeWorkflowId) : null;
  const activeEditorIssues = activeTabState?.editorIssues ?? [];
  const activeValidationIssues = activeTabState?.validationIssues ?? [];
  const visibleActiveValidationIssues = activeEditorIssues.length > 0 ? [] : activeValidationIssues;
  const activeWorkflowIssues = buildWorkflowIssueDisplayItems(
    activeEditorIssues,
    visibleActiveValidationIssues,
    activeTabState?.stepBlockIdsByStepId ?? {},
  );
  const activeWorkspaceState = activeTabState?.workspaceState ?? null;
  const activeAIState = activeTabState?.aiState ?? createEmptyAIState();
  const visibleWarnings = workbook && activeTable ? [...workbook.importWarnings, ...activeTable.importWarnings] : [];
  const workflowExtraColumnIds = activeWorkflow ? collectWorkflowColumnIds(activeWorkflow) : [];
  const canRunWorkflow = Boolean(
    activeTable
      && activeWorkflow
      && activeWorkflowRunContextWorkflowIds.length > 0
      && activeWorkflowRunContextWorkflowIds.every((workflowId) => {
        const tabState = getWorkflowTabState(workflowTabStates, workflowId);
        return tabState.editorIssues.length === 0 && tabState.validationIssues.length === 0;
      }),
  );
  const canRunSequence = Boolean(
    activeTable
      && workflowPackage
      && workflowPackage.runOrderWorkflowIds.length > 0
      && workflowPackage.runOrderWorkflowIds.every((workflowId) => {
        const tabState = getWorkflowTabState(workflowTabStates, workflowId);
        return tabState.editorIssues.length === 0 && tabState.validationIssues.length === 0;
      }),
  );
  const canUseAI = Boolean(activeTable && activeWorkflow);
  const canDownloadAIPrompt = Boolean(canUseAI && (activeAIState.promptValue.trim() !== '' || activeAIState.lastPromptRequestExport));
  const aiUsesLastValidWorkflow = Boolean(activeWorkflow && activeEditorIssues.length > 0);
  const aiWorkflowIssueNotice = activeWorkflowIssues.length === 0
    ? null
    : aiUsesLastValidWorkflow
      ? 'The current block workspace has issues. AI will receive the live block snapshot and the issue list, and it will draft from the last valid workflow snapshot. Applying the draft will replace the broken workspace.'
      : 'The current workflow has issues. AI will receive the live block snapshot and the issue list when drafting.';
  const aiDraftPreviewWorkflow = buildDraftPreviewWorkflow(activeWorkflow, activeAIState.draft);
  const aiDraftPreviewTable = activeAIState.draft?.kind === 'workflowSet' ? activeTable : activeWorkflowInputTable;
  const aiDraftDebugJson = formatDraftStepsForDebug(activeAIState.draft);
  const exportableWorkflowIds = useMemo(
    () =>
      workflowPackage
        ? workflowPackage.workflows
          .filter((workflow) => getWorkflowTabState(workflowTabStates, workflow.workflowId).editorIssues.length === 0)
          .map((workflow) => workflow.workflowId)
        : [],
    [workflowPackage, workflowTabStates],
  );

  function updateWorkflowTabState(workflowId: string, updater: (state: WorkflowTabRuntimeState) => WorkflowTabRuntimeState) {
    setWorkflowTabStates((current) => {
      const currentState = getWorkflowTabState(current, workflowId);
      return {
        ...current,
        [workflowId]: updater(currentState),
      };
    });
  }

  function updateWorkflowAIState(workflowId: string, updater: (state: WorkflowAIState) => WorkflowAIState) {
    updateWorkflowTabState(workflowId, (currentState) => ({
      ...currentState,
      aiState: updater(currentState.aiState),
    }));
  }

  function resetWorkflowImportDialogState() {
    setWorkflowImportMode('choice');
    setWorkflowImportPasteValue('');
    workflowImportDragDepthRef.current = 0;
    setIsWorkflowImportDragActive(false);
    setPendingImportedWorkflowPackage(null);
  }

  function resetWorkflowPackage(nextWorkflowPackage: WorkflowPackageV1 | null) {
    setWorkflowPackage(nextWorkflowPackage);
    setWorkflowTabStates(nextWorkflowPackage ? createWorkflowTabStates(nextWorkflowPackage.workflows) : {});
    setWorkflowLoadVersion((version) => version + 1);
    setWorkflowJsonError(null);
    setExecutionResult(null);
    setLastRunContext(null);
    setIsWorkflowImportDialogOpen(false);
    setIsWorkflowExportDialogOpen(false);
    setIsRunOrderDialogOpen(false);
    setIsAIDialogOpen(false);
    resetWorkflowImportDialogState();
  }

  useEffect(() => {
    const abortController = new AbortController();

    const cancelScheduledValidation = () => {
      if (validationDebounceTimerRef.current !== null) {
        window.clearTimeout(validationDebounceTimerRef.current);
        validationDebounceTimerRef.current = null;
      }

      abortController.abort();
    };

    cancelScheduledValidation();

    if (!activeTable || !workflowPackage) {
      setWorkflowTabStates((current) =>
        Object.keys(current).length === 0
          ? current
          : Object.fromEntries(
            Object.entries(current).map(([workflowId, state]) => [
              workflowId,
              {
                ...state,
                validationIssues: [],
              },
            ]),
          ));
      return cancelScheduledValidation;
    }

    const tableSnapshot = createValidationWorkerTableSnapshot(activeTable);
    const requestId = validationRequestIdRef.current + 1;

    validationRequestIdRef.current = requestId;

    validationDebounceTimerRef.current = window.setTimeout(() => {
      validationDebounceTimerRef.current = null;
      void validateWorkflowPackageWithWorker(workflowPackage, tableSnapshot, abortController.signal)
        .then((issuesByWorkflowId) => {
          if (requestId !== validationRequestIdRef.current) {
            return;
          }

          startTransition(() => {
            setWorkflowTabStates((current) =>
              Object.fromEntries(
                workflowPackage.workflows.map((workflow) => {
                  const currentState = getWorkflowTabState(current, workflow.workflowId);
                  return [
                    workflow.workflowId,
                    {
                      ...currentState,
                      validationIssues: issuesByWorkflowId.get(workflow.workflowId) ?? [],
                    },
                  ];
                }),
              ));
          });
        })
        .catch((caughtError) => {
          if (isAbortError(caughtError)) {
            return;
          }
        });
    }, 150);

    return cancelScheduledValidation;
  }, [activeTable, workflowPackage]);

  useEffect(() => {
    window.localStorage.setItem(GEMINI_API_KEY_STORAGE_KEY, aiSettings.apiKey);
    window.localStorage.setItem(GEMINI_MODEL_STORAGE_KEY, selectedAIModel);
    window.localStorage.setItem(GEMINI_THINKING_ENABLED_STORAGE_KEY, aiSettings.thinkingEnabled ? 'true' : 'false');
  }, [aiSettings.apiKey, aiSettings.thinkingEnabled, selectedAIModel]);

  useEffect(() => {
    setIsAIDialogOpen(false);
    setWorkflowTabStates((current) =>
      Object.keys(current).length === 0
        ? current
        : Object.fromEntries(
          Object.entries(current).map(([workflowId, state]) => [
            workflowId,
            {
              ...state,
              aiState: createEmptyAIState(),
            },
          ]),
        ));
  }, [activeTable?.tableId]);

  useEffect(() => {
    if (!pendingRunResultScrollRef.current || !executionResult) {
      return;
    }

    const target = runResultSectionRef.current;

    if (!target) {
      return;
    }

    pendingRunResultScrollRef.current = false;
    window.requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }, [executionResult]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await importWorkbookFile(file);
    event.target.value = '';
  }

  async function importWorkbookFile(file: File) {
    setLoading(true);
    setError(null);

    try {
      const importedWorkbook = await importWorkbookFromFile(file);
      const importedTable = getActiveTable(importedWorkbook);

      startTransition(() => {
        setWorkbookState(importedWorkbook);
      });

      if (importedTable) {
        resetWorkflowPackage(createSingleWorkflowPackage(createDefaultWorkflow(importedTable)));
      } else {
        resetWorkflowPackage(null);
      }
    } catch (caughtError) {
      setWorkbookState(null);
      resetWorkflowPackage(null);
      setError(caughtError instanceof Error ? caughtError.message : 'Import failed.');
    } finally {
      setLoading(false);
    }
  }

  function handleUploadDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    uploadDragDepthRef.current += 1;
    setIsUploadDragActive(true);
  }

  function handleUploadDragOver(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsUploadDragActive(true);
  }

  function handleUploadDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    uploadDragDepthRef.current = Math.max(0, uploadDragDepthRef.current - 1);

    if (uploadDragDepthRef.current === 0) {
      setIsUploadDragActive(false);
    }
  }

  async function handleUploadDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    uploadDragDepthRef.current = 0;
    setIsUploadDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (!file) {
      return;
    }

    await importWorkbookFile(file);
  }

  function handleActiveTableChange(event: ChangeEvent<HTMLSelectElement>) {
    if (!workbook) {
      return;
    }

    setWorkbookState(setActiveTable(workbook, event.target.value));
    setExecutionResult(null);
    setLastRunContext(null);
  }

  function handleEditorWorkspaceChange(result: EditorWorkspaceChange) {
    if (!activeWorkflowId) {
      return;
    }

    startTransition(() => {
      setWorkflowTabStates((current) => {
        const currentState = getWorkflowTabState(current, activeWorkflowId);

        return {
          ...current,
          [activeWorkflowId]: {
            ...currentState,
            editorIssues: result.issues,
            stepBlockIdsByStepId: result.stepBlockIdsByStepId,
            workspacePromptSnapshot: result.workspacePromptSnapshot,
            workspaceState: result.workspaceState,
          },
        };
      });
      setWorkflowPackage((currentPackage) => {
        if (!currentPackage) {
          return currentPackage;
        }

        const currentWorkflow = getWorkflowById(currentPackage, activeWorkflowId);

        if (!currentWorkflow) {
          return currentPackage;
        }

        let nextPackage = updateWorkflowDescriptionInPackage(currentPackage, activeWorkflowId, result.metadata.description);

        if (!result.workflow) {
          return nextPackage;
        }

        nextPackage = replaceWorkflowInPackage(nextPackage, activeWorkflowId, {
          version: result.workflow.version,
          workflowId: currentWorkflow.workflowId,
          name: currentWorkflow.name,
          ...(result.metadata.description?.trim() ? { description: result.metadata.description.trim() } : {}),
          steps: result.workflow.steps,
        });

        return nextPackage;
      });
    });
  }

  function handleExportTableCsv(table: Table | null) {
    if (!table) {
      return;
    }

    downloadBlob(exportTableCsvBlob(table), buildCsvExportFileName(table));
  }

  function handleExportTableXlsx(table: Table | null) {
    if (!table) {
      return;
    }

    downloadBlob(exportTableXlsxBlob(table), buildXlsxExportFileName(table));
  }

  function handleRunWorkflow() {
    if (!activeTable || !workflowPackage || !activeWorkflow) {
      return;
    }

    const workflowsToRun = activeWorkflowRunContextWorkflowIds.length > 1
      ? flattenWorkflowSequence(workflowPackage.workflows, activeWorkflowRunContextWorkflowIds)
      : {
          workflow: activeWorkflow,
          workflowIds: [activeWorkflow.workflowId],
          workflowNames: [activeWorkflow.name],
        };

    pendingRunResultScrollRef.current = true;
    setExecutionResult(executeWorkflow(workflowsToRun.workflow, activeTable));
    setLastRunContext({
      kind: workflowsToRun.workflowIds.length > 1 ? 'sequence' : 'workflow',
      workflowIds: workflowsToRun.workflowIds,
      workflowNames: workflowsToRun.workflowNames,
    });
  }

  function handleRunSequence() {
    if (!activeTable || !workflowPackage || workflowPackage.runOrderWorkflowIds.length === 0) {
      return;
    }

    const flattenedSequence = flattenWorkflowSequence(workflowPackage.workflows, workflowPackage.runOrderWorkflowIds);

    pendingRunResultScrollRef.current = true;
    setExecutionResult(executeWorkflow(flattenedSequence.workflow, activeTable));
    setLastRunContext({
      kind: 'sequence',
      workflowIds: flattenedSequence.workflowIds,
      workflowNames: flattenedSequence.workflowNames,
    });
  }

  async function handleImportWorkflowPackageFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await importWorkflowPackageFile(file);
    event.target.value = '';
  }

  async function importWorkflowPackageFile(file: File) {
    await importWorkflowPackageText(await file.text());
  }

  async function importWorkflowPackageText(text: string) {
    const parsed = parseWorkflowPackageJson(text);

    if (!parsed.workflowPackage) {
      setWorkflowJsonError(parsed.issues.map((issue) => issue.message).join('\n'));
      return false;
    }

    setWorkflowJsonError(null);
    setPendingImportedWorkflowPackage(parsed.workflowPackage);
    setWorkflowImportMode('decision');
    return true;
  }

  function handleOpenWorkflowImportDialog() {
    setWorkflowJsonError(null);
    resetWorkflowImportDialogState();
    setIsWorkflowImportDialogOpen(true);
  }

  function handleCloseWorkflowImportDialog() {
    resetWorkflowImportDialogState();
    setIsWorkflowImportDialogOpen(false);
  }

  function handleChooseWorkflowImportFile() {
    workflowImportInputRef.current?.click();
  }

  function handleOpenWorkflowExportDialog() {
    if (!workflowPackage) {
      return;
    }

    setIsWorkflowExportDialogOpen(true);
  }

  function handleCloseWorkflowExportDialog() {
    setIsWorkflowExportDialogOpen(false);
  }

  function handleExportWorkflowPackage(selectedWorkflowIds: string[]) {
    if (!workflowPackage) {
      return;
    }

    const exportWorkflowPackage = buildExportWorkflowPackage(workflowPackage, selectedWorkflowIds);

    downloadBlob(
      new Blob([workflowPackageToJson(exportWorkflowPackage)], { type: 'application/json;charset=utf-8' }),
      buildWorkflowPackageExportFileName(exportWorkflowPackage),
    );
    setIsWorkflowExportDialogOpen(false);
  }

  function handleOpenRunOrderDialog() {
    if (!workflowPackage) {
      return;
    }

    setIsRunOrderDialogOpen(true);
  }

  function handleCloseRunOrderDialog() {
    setIsRunOrderDialogOpen(false);
  }

  function handleApplyRunOrder(nextRunOrderWorkflowIds: string[]) {
    setWorkflowPackage((currentPackage) =>
      currentPackage
        ? setRunOrderInPackage(currentPackage, nextRunOrderWorkflowIds)
        : currentPackage);
    setIsRunOrderDialogOpen(false);
  }

  function handleOpenAIDialog() {
    if (!activeWorkflowId) {
      return;
    }

    updateWorkflowAIState(activeWorkflowId, (state) => ({
      ...state,
      error: null,
    }));
    setIsAIDialogOpen(true);
  }

  function handleCloseAIDialog() {
    if (activeWorkflowId) {
      updateWorkflowAIState(activeWorkflowId, (state) => ({
        ...state,
        error: null,
      }));
    }

    setIsAIDialogOpen(false);
  }

  async function handleImportWorkflowPaste() {
    await importWorkflowPackageText(workflowImportPasteValue);
  }

  function handleReplaceImportedWorkflowPackage() {
    if (!pendingImportedWorkflowPackage) {
      return;
    }

    resetWorkflowPackage(pendingImportedWorkflowPackage);
  }

  function handleMergeImportedWorkflowPackage() {
    if (!pendingImportedWorkflowPackage) {
      return;
    }

    setWorkflowPackage((currentPackage) => {
      if (!currentPackage) {
        return currentPackage;
      }

      const currentWorkflowIdSet = new Set(currentPackage.workflows.map((workflow) => workflow.workflowId));
      const nextPackage = mergeWorkflowPackages(currentPackage, pendingImportedWorkflowPackage);

      setWorkflowTabStates((current) => {
        const nextStates = { ...current };

        nextPackage.workflows.forEach((workflow) => {
          if (!currentWorkflowIdSet.has(workflow.workflowId)) {
            nextStates[workflow.workflowId] = createWorkflowTabRuntimeState();
          }
        });

        return nextStates;
      });

      return nextPackage;
    });

    setWorkflowJsonError(null);
    setExecutionResult(null);
    setLastRunContext(null);
    handleCloseWorkflowImportDialog();
  }

  function handleWorkflowImportDragEnter(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    workflowImportDragDepthRef.current += 1;
    setIsWorkflowImportDragActive(true);
  }

  function handleWorkflowImportDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsWorkflowImportDragActive(true);
  }

  function handleWorkflowImportDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    workflowImportDragDepthRef.current = Math.max(0, workflowImportDragDepthRef.current - 1);

    if (workflowImportDragDepthRef.current === 0) {
      setIsWorkflowImportDragActive(false);
    }
  }

  async function handleWorkflowImportDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    workflowImportDragDepthRef.current = 0;
    setIsWorkflowImportDragActive(false);

    const file = event.dataTransfer.files?.[0];

    if (!file) {
      return;
    }

    await importWorkflowPackageFile(file);
  }

  async function validateCandidateWorkflow(candidateWorkflow: Workflow) {
    if (!activeWorkflowInputTable) {
      return [];
    }

    const tableSnapshot = createValidationWorkerTableSnapshot(activeWorkflowInputTable);
    return validateWorkflowWithWorker(candidateWorkflow, tableSnapshot);
  }

  async function validateCandidateWorkflowSet(candidateWorkflows: Workflow[], runOrderWorkflowIds: string[]) {
    if (!activeTable || candidateWorkflows.length === 0) {
      return [];
    }

    const tableSnapshot = createValidationWorkerTableSnapshot(activeTable);
    const flattenedSequence = flattenWorkflowSequence(candidateWorkflows, runOrderWorkflowIds);

    return validateWorkflowWithWorker(flattenedSequence.workflow, tableSnapshot);
  }

  async function handleSendAIPrompt() {
    if (!activeTable || !activeWorkflowId || !activeWorkflow) {
      return;
    }

    const workflowContextTable = activeWorkflowInputTable ?? activeTable;
    const currentTabState = getWorkflowTabState(workflowTabStates, activeWorkflowId);
    const currentAIState = currentTabState.aiState;
    const userText = currentAIState.promptValue.trim();

    if (currentAIState.isLoading || userText === '') {
      return;
    }

    if (aiSettings.apiKey.trim() === '') {
      updateWorkflowAIState(activeWorkflowId, (state) => ({
        ...state,
        error: 'Enter a Gemini API key before sending a prompt.',
      }));
      return;
    }

    const currentIssues = mergeWorkflowIssues(
      currentTabState.editorIssues,
      currentTabState.editorIssues.length > 0 ? [] : currentTabState.validationIssues,
    );
    const requestExport = buildGeminiRequestExport({
      settings: {
        apiKey: aiSettings.apiKey.trim(),
        model: selectedAIModel,
        thinkingEnabled: aiSettings.thinkingEnabled,
      },
      context: {
        table: workflowContextTable,
        workflow: activeWorkflow,
        draft: currentAIState.draft,
        messages: currentAIState.messages,
        currentIssues: currentIssues.map((issue) => ({
          code: issue.code,
          message: issue.message,
        })),
        workflowContextSource: currentTabState.editorIssues.length === 0 ? 'current' : 'lastValidSnapshot',
        workspacePromptSnapshot: currentTabState.workspacePromptSnapshot,
      },
      userMessage: {
        role: 'user',
        text: userText,
        timestamp: new Date().toISOString(),
      },
      phase: 'initial',
    });

    updateWorkflowAIState(activeWorkflowId, (state) => ({
      ...state,
      isLoading: true,
      error: null,
      progressEvents: [],
      lastPromptRequestExport: requestExport,
    }));
    const turnId = createAITurnId();
    const turnStartedAt = Date.now();

    void appendAIDevLog({
      turnId,
      kind: 'turn_start',
      prompt: userText,
      model: selectedAIModel,
      thinkingEnabled: aiSettings.thinkingEnabled,
      workflowId: activeWorkflow.workflowId,
      activeTableId: activeTable.tableId,
    });

    try {
      const outcome = await runGeminiDraftTurn({
        settings: {
          apiKey: aiSettings.apiKey.trim(),
          model: selectedAIModel,
          thinkingEnabled: aiSettings.thinkingEnabled,
        },
        context: {
          table: workflowContextTable,
          workflow: activeWorkflow,
          draft: currentAIState.draft,
          messages: currentAIState.messages,
          currentIssues: currentIssues.map((issue) => ({
            code: issue.code,
            message: issue.message,
          })),
          workflowContextSource: currentTabState.editorIssues.length === 0 ? 'current' : 'lastValidSnapshot',
          workspacePromptSnapshot: currentTabState.workspacePromptSnapshot,
        },
        userText,
        validateCandidateWorkflow,
        validateCandidateWorkflowSet,
        onProgress: (event) => {
          updateWorkflowAIState(activeWorkflowId, (state) => ({
            ...state,
            progressEvents: [...state.progressEvents, event],
          }));
          console.info(`[AI] ${event.stage}: ${event.message}`);
          void appendAIDevLog({
            turnId,
            kind: 'progress',
            stage: event.stage,
            message: event.message,
            timestamp: event.timestamp,
          });
        },
        onGeminiLogEvent: (event) => {
          logGeminiClientEvent(turnId, event);
        },
      });

      await appendAIDevLog({
        turnId,
        kind: 'turn_result',
        outcomeKind: outcome.kind,
        repaired: outcome.repaired,
        durationMs: Date.now() - turnStartedAt,
        assistantMessage: outcome.assistantMessage.text,
        debugTrace: outcome.debugTrace,
        ...(outcome.kind === 'draft'
          ? { draftStepCount: getAIDraftStepCount(outcome.draft), draftKind: outcome.draft.kind }
          : outcome.kind === 'invalidDraft'
            ? { validationIssues: outcome.validationIssues }
            : {}),
      });

      updateWorkflowAIState(activeWorkflowId, (state) => {
        const nextState: WorkflowAIState = {
          ...state,
          messages: [...state.messages, outcome.userMessage, outcome.assistantMessage],
          debugTrace: outcome.debugTrace,
          promptValue: '',
          error: null,
          isLoading: false,
        };

        if (outcome.kind === 'draft') {
          return {
            ...nextState,
            draft: outcome.draft,
            draftIssues: [],
          };
        }

        if (outcome.kind === 'invalidDraft') {
          return {
            ...nextState,
            draftIssues: outcome.validationIssues,
          };
        }

        return {
          ...nextState,
          draftIssues: [],
        };
      });
    } catch (caughtError) {
      console.error('[AI] error', caughtError);
      await appendAIDevLog({
        turnId,
        kind: 'turn_error',
        durationMs: Date.now() - turnStartedAt,
        error: caughtError instanceof Error ? caughtError.message : 'Gemini request failed.',
      });
      updateWorkflowAIState(activeWorkflowId, (state) => ({
        ...state,
        progressEvents: [
          ...state.progressEvents,
          {
            stage: 'error',
            message: caughtError instanceof Error ? caughtError.message : 'Gemini request failed.',
            timestamp: new Date().toISOString(),
          },
        ],
        error: caughtError instanceof Error ? caughtError.message : 'Gemini request failed.',
        isLoading: false,
      }));
    }
  }

  async function handleApplyAIDraft() {
    if (!activeWorkflowId || !activeWorkflow || !workflowPackage) {
      return;
    }

    const currentAIState = getWorkflowTabState(workflowTabStates, activeWorkflowId).aiState;

    if (!currentAIState.draft || currentAIState.isLoading) {
      return;
    }

    updateWorkflowAIState(activeWorkflowId, (state) => ({
      ...state,
      isLoading: true,
      error: null,
    }));

    try {
      if (currentAIState.draft.kind === 'workflowSet') {
        const applied = applyWorkflowSetDraftToPackage(workflowPackage, activeWorkflowId, currentAIState.draft);

        if (!activeTable) {
          throw new Error('Load a table before applying an AI workflow-set draft.');
        }

        const tableSnapshot = createValidationWorkerTableSnapshot(activeTable);
        const issuesByWorkflowId = await validateWorkflowPackageWithWorker(applied.workflowPackage, tableSnapshot);
        const issues = applied.workflowPackage.runOrderWorkflowIds.flatMap((workflowId) => issuesByWorkflowId.get(workflowId) ?? []);

        if (issues.length > 0) {
          updateWorkflowAIState(activeWorkflowId, (state) => ({
            ...state,
            draftIssues: issues.map(mapWorkflowValidationIssueToAIDraftIssue),
            error: 'The current workflow-set draft no longer validates against the latest workflow context.',
            isLoading: false,
          }));
          return;
        }

        setWorkflowPackage(applied.workflowPackage);
        setWorkflowTabStates((current) =>
          Object.fromEntries(
            applied.workflowPackage.workflows.map((workflow) => {
              const currentState = getWorkflowTabState(current, workflow.workflowId);
              return [
                workflow.workflowId,
                {
                  ...currentState,
                  ...(workflow.workflowId === applied.workflowPackage.activeWorkflowId || workflow.workflowId === activeWorkflowId
                    ? {
                        editorIssues: [],
                        validationIssues: [],
                        stepBlockIdsByStepId: {},
                        workspacePromptSnapshot: '',
                        workspaceState: null,
                        aiState: {
                          ...currentState.aiState,
                          draft: null,
                          draftIssues: [],
                          error: null,
                          isLoading: false,
                          promptValue: '',
                        },
                      }
                    : {}),
                },
              ];
            }),
          ));
        setWorkflowLoadVersion((version) => version + 1);
        setIsAIDialogOpen(false);
        return;
      }

      const candidateWorkflow = replaceWorkflowSteps(activeWorkflow, currentAIState.draft.steps);
      const issues = await validateCandidateWorkflow(candidateWorkflow);

      if (issues.length > 0) {
        updateWorkflowAIState(activeWorkflowId, (state) => ({
          ...state,
          draftIssues: issues.map(mapWorkflowValidationIssueToAIDraftIssue),
          error: 'The current draft no longer validates against the latest workflow context.',
          isLoading: false,
        }));
        return;
      }

      setWorkflowPackage((currentPackage) =>
        currentPackage
          ? replaceWorkflowInPackage(currentPackage, activeWorkflowId, candidateWorkflow)
          : currentPackage);
      setWorkflowTabStates((current) => {
        const currentState = getWorkflowTabState(current, activeWorkflowId);
        return {
          ...current,
          [activeWorkflowId]: {
            ...currentState,
            editorIssues: [],
            validationIssues: [],
            stepBlockIdsByStepId: {},
            workspacePromptSnapshot: '',
            workspaceState: null,
            aiState: {
              ...currentState.aiState,
              draft: null,
              draftIssues: [],
              error: null,
              isLoading: false,
              promptValue: '',
            },
          },
        };
      });
      setWorkflowLoadVersion((version) => version + 1);
      setIsAIDialogOpen(false);
    } catch (caughtError) {
      updateWorkflowAIState(activeWorkflowId, (state) => ({
        ...state,
        error: caughtError instanceof Error ? caughtError.message : 'Failed to apply the AI draft.',
        isLoading: false,
      }));
    }
  }

  function handleDiscardAIDraft() {
    if (!activeWorkflowId) {
      return;
    }

    updateWorkflowAIState(activeWorkflowId, (state) => ({
      ...state,
      draft: null,
      draftIssues: [],
      error: null,
    }));
  }

  function handleDownloadAIPrompt() {
    if (!activeTable || !activeWorkflowId || !activeWorkflow) {
      return;
    }

    const workflowContextTable = activeWorkflowInputTable ?? activeTable;
    const currentTabState = getWorkflowTabState(workflowTabStates, activeWorkflowId);
    const currentAIState = currentTabState.aiState;
    const userText = currentAIState.promptValue.trim();

    const requestExport = userText === ''
      ? currentAIState.lastPromptRequestExport
      : buildGeminiRequestExport({
          settings: {
            apiKey: aiSettings.apiKey.trim(),
            model: selectedAIModel,
            thinkingEnabled: aiSettings.thinkingEnabled,
          },
          context: {
            table: workflowContextTable,
            workflow: activeWorkflow,
            draft: currentAIState.draft,
            messages: currentAIState.messages,
            currentIssues: mergeWorkflowIssues(
              currentTabState.editorIssues,
              currentTabState.editorIssues.length > 0 ? [] : currentTabState.validationIssues,
            ).map((issue) => ({
              code: issue.code,
              message: issue.message,
            })),
            workflowContextSource: currentTabState.editorIssues.length === 0 ? 'current' : 'lastValidSnapshot',
            workspacePromptSnapshot: currentTabState.workspacePromptSnapshot,
          },
          userMessage: {
            role: 'user',
            text: userText,
            timestamp: new Date().toISOString(),
          },
          phase: 'initial',
        });

    if (!requestExport) {
      return;
    }

    downloadBlob(
      new Blob([JSON.stringify(requestExport, null, 2)], { type: 'application/json;charset=utf-8' }),
      buildAIPromptExportFileName(activeWorkflow),
    );
  }

  function handleSelectWorkflowTab(workflowId: string) {
    if (!workflowPackage || workflowId === workflowPackage.activeWorkflowId) {
      return;
    }

    editorRef.current?.flushWorkspaceChange();
    setWorkflowPackage((currentPackage) =>
      currentPackage
        ? setActiveWorkflowInPackage(currentPackage, workflowId)
        : currentPackage);
    setStartRenameWorkflowId(null);
    setWorkflowLoadVersion((version) => version + 1);
    setIsAIDialogOpen(false);
  }

  function handleCreateWorkflowTab() {
    if (!workflowPackage) {
      return;
    }

    editorRef.current?.flushWorkspaceChange();

    const createdWorkflow = createNewPackageWorkflow(workflowPackage.workflows);
    const createdWorkflowId = createdWorkflow.workflowId;

    setWorkflowPackage((currentPackage) =>
      currentPackage
        ? addWorkflowToPackage(currentPackage, createdWorkflow, true, true)
        : currentPackage);
    setWorkflowTabStates((current) => ({
      ...current,
      [createdWorkflowId]: createWorkflowTabRuntimeState(),
    }));
    setStartRenameWorkflowId(createdWorkflowId);
    setWorkflowLoadVersion((version) => version + 1);
    setIsAIDialogOpen(false);
  }

  function handleRenameWorkflowTab(workflowId: string, nextName: string) {
    const normalizedName = nextName.trim();

    if (normalizedName === '') {
      return;
    }

    if (workflowId === activeWorkflowId) {
      editorRef.current?.flushWorkspaceChange();
    }

    setWorkflowPackage((currentPackage) =>
      currentPackage
        ? renameWorkflowInPackage(currentPackage, workflowId, normalizedName)
        : currentPackage);

    if (workflowId === activeWorkflowId) {
      setWorkflowLoadVersion((version) => version + 1);
    }
  }

  function handleDeleteWorkflowTab(workflowId: string) {
    if (!workflowPackage) {
      return;
    }

    if (workflowPackage.workflows.length <= 1) {
      window.alert('Cannot delete the final workflow.');
      return;
    }

    const workflowToDelete = getWorkflowById(workflowPackage, workflowId);

    if (!workflowToDelete || !window.confirm(`Are you sure you want to delete "${workflowToDelete.name}"?`)) {
      return;
    }

    const deletingActiveWorkflow = workflowId === workflowPackage.activeWorkflowId;

    if (deletingActiveWorkflow) {
      editorRef.current?.flushWorkspaceChange();
    }

    setWorkflowPackage((currentPackage) =>
      currentPackage
        ? deleteWorkflowFromPackage(currentPackage, workflowId)
        : currentPackage);
    setStartRenameWorkflowId((currentWorkflowId) => (currentWorkflowId === workflowId ? null : currentWorkflowId));
    setWorkflowTabStates((current) => {
      const nextStates = { ...current };
      delete nextStates[workflowId];
      return nextStates;
    });

    if (deletingActiveWorkflow) {
      setWorkflowLoadVersion((version) => version + 1);
      setIsAIDialogOpen(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <h1>Scratch My Table</h1>
        </div>
      </section>

      <section className="toolbar">
        <label
          className={`summary-card summary-card--upload${isUploadDragActive ? ' summary-card--upload-drag-active' : ''}`}
          onDragEnter={handleUploadDragEnter}
          onDragLeave={handleUploadDragLeave}
          onDragOver={handleUploadDragOver}
          onDrop={(event) => {
            void handleUploadDrop(event);
          }}
        >
          <p className="summary-label">Upload</p>
          <strong>Upload CSV or XLSX</strong>
          <span className="summary-card__hint">Drop a file anywhere in this card, or click to choose one.</span>
          <input accept=".csv,.xlsx" onChange={handleFileChange} type="file" />
        </label>
        {workbook ? (
          <div className="summary-card">
            <p className="summary-label">Source file</p>
            <strong>{workbook.sourceFileName}</strong>
            <p>{workbook.sourceFormat.toUpperCase()} import</p>
          </div>
        ) : null}
      </section>

      {loading ? <section className="status-card">Importing file...</section> : null}
      {error ? <section className="status-card status-card--error">{error}</section> : null}

      {!workbook || !activeTable ? (
        <section className="empty-state">
          <h2>No workbook loaded</h2>
          <p>Start with one of the provided fixtures: <code>simple-customers.csv</code>, <code>messy-customers.csv</code>, or <code>orders-sample.csv</code>.</p>
        </section>
      ) : (
        <>
          <section className="panel-grid">
            <SchemaPanel table={activeTable} />
            <WarningsPanel warnings={visibleWarnings} />
          </section>

          <PreviewPanel
            allowFullscreen
            description={`Showing ${previewRows.length} of ${activeTable.rowOrder.length} rows.`}
            headerControls={
              <label className="selector preview-panel-selector">
                <span>Active table / sheet</span>
                <select onChange={handleActiveTableChange} value={workbook.activeTableId}>
                  {workbook.tables.map((table) => (
                    <option key={table.tableId} value={table.tableId}>
                      {table.sourceName}
                    </option>
                  ))}
                </select>
              </label>
            }
            previewRows={previewRows}
            table={activeTable}
            title="Active table preview"
          />

          {workflowPackage && activeWorkflow ? (
            <section className="panel panel--editor">
              <WorkflowEditor
                ref={editorRef}
                canExportWorkflows={exportableWorkflowIds.length > 0}
                canRunSequence={canRunSequence}
                canRunWorkflow={canRunWorkflow}
                canUseAI={canUseAI}
                extraColumnIds={workflowExtraColumnIds}
                issues={activeWorkflowIssues}
                jsonError={workflowJsonError}
                loadMetadata={getWorkflowMetadata(activeWorkflow)}
                loadVersion={workflowLoadVersion}
                loadWorkflow={activeWorkflow}
                loadWorkflowState={activeWorkspaceState}
                onExportWorkflows={handleOpenWorkflowExportDialog}
                onOpenAIDialog={handleOpenAIDialog}
                onOpenRunOrderDialog={handleOpenRunOrderDialog}
                onOpenWorkflowImportDialog={handleOpenWorkflowImportDialog}
                onRunSequence={handleRunSequence}
                onRunWorkflow={handleRunWorkflow}
                onWorkspaceChange={handleEditorWorkspaceChange}
                table={activeWorkflowInputTable ?? activeTable}
                workflowTabs={
                  <WorkflowTabs
                    activeWorkflowId={workflowPackage.activeWorkflowId}
                    onCreateWorkflow={handleCreateWorkflowTab}
                    onDeleteWorkflow={handleDeleteWorkflowTab}
                    onRenameWorkflow={handleRenameWorkflowTab}
                    onSelectWorkflow={handleSelectWorkflowTab}
                    onStartRenameHandled={() => setStartRenameWorkflowId(null)}
                    startRenameWorkflowId={startRenameWorkflowId}
                    workflowTabStates={workflowTabStates}
                    workflows={workflowPackage.workflows}
                  />
                }
              />
            </section>
          ) : null}

          {executionResult ? (
            <section className="panel-stack" ref={runResultSectionRef}>
              <RunResultPanel
                executionResult={executionResult}
                onExportCsv={() => {
                  handleExportTableCsv(resultTable);
                }}
                onExportXlsx={() => {
                  handleExportTableXlsx(resultTable);
                }}
                runContext={lastRunContext}
              />
              {resultTable ? (
                <PreviewPanel
                  allowFullscreen
                  description={`Showing ${resultPreviewRows.length} of ${resultTable.rowOrder.length} transformed rows.`}
                  previewRows={resultPreviewRows}
                  table={resultTable}
                  title="Run result"
                />
              ) : null}
            </section>
          ) : null}
        </>
      )}

      <input
        accept=".json,application/json"
        className="workflow-hidden-input"
        onChange={handleImportWorkflowPackageFile}
        ref={workflowImportInputRef}
        type="file"
      />

      {isWorkflowImportDialogOpen ? (
        <div className="workflow-import-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-import-title">
          <div className="workflow-import-modal__scrim" onClick={handleCloseWorkflowImportDialog} />
          <section className="workflow-import-modal__panel">
            <div className="panel-header">
              <div>
                <h2 id="workflow-import-title">Import workflow(s)</h2>
                <p>Load canonical workflow package JSON from a file or paste it directly.</p>
              </div>
            </div>

            {workflowJsonError ? <pre className="json-error-panel">{workflowJsonError}</pre> : null}

            {workflowImportMode === 'choice' ? (
              <div className="workflow-import-options">
                <button
                  className={`workflow-import-option${isWorkflowImportDragActive ? ' workflow-import-option--drag-active' : ''}`}
                  onClick={handleChooseWorkflowImportFile}
                  onDragEnter={handleWorkflowImportDragEnter}
                  onDragLeave={handleWorkflowImportDragLeave}
                  onDragOver={handleWorkflowImportDragOver}
                  onDrop={(event) => {
                    void handleWorkflowImportDrop(event);
                  }}
                  type="button"
                >
                  <strong>Import from file</strong>
                  <span>Open the file selector or drop a `.json` workflow package here.</span>
                </button>
                <button className="workflow-import-option" onClick={() => setWorkflowImportMode('paste')} type="button">
                  <strong>Paste workflow package JSON</strong>
                  <span>Paste canonical workflow package JSON into a text area and validate it directly.</span>
                </button>
              </div>
            ) : workflowImportMode === 'paste' ? (
              <div className="workflow-import-paste">
                <textarea
                  className="json-viewer"
                  onChange={(event) => setWorkflowImportPasteValue(event.target.value)}
                  placeholder="Paste workflow package JSON here"
                  value={workflowImportPasteValue}
                />
                <div className="workflow-import-actions">
                  <button onClick={() => setWorkflowImportMode('choice')} type="button">
                    Back
                  </button>
                  <button disabled={workflowImportPasteValue.trim() === ''} onClick={() => void handleImportWorkflowPaste()} type="button">
                    Validate package
                  </button>
                </div>
              </div>
            ) : pendingImportedWorkflowPackage ? (
              <div className="workflow-import-paste workflow-package-summary">
                <strong>{pendingImportedWorkflowPackage.workflows.length} workflow{pendingImportedWorkflowPackage.workflows.length === 1 ? '' : 's'} ready to import</strong>
                <p>Choose whether to replace the current package or merge the imported workflows into it.</p>
                <ul className="workflow-package-summary__list">
                  {pendingImportedWorkflowPackage.workflows.map((workflow) => (
                    <li key={workflow.workflowId}>
                      <strong>{workflow.name}</strong>
                      <span>{workflow.workflowId}</span>
                    </li>
                  ))}
                </ul>
                <div className="workflow-import-actions">
                  <button onClick={() => setWorkflowImportMode('choice')} type="button">
                    Back
                  </button>
                  <button onClick={handleReplaceImportedWorkflowPackage} type="button">
                    Replace current package
                  </button>
                  <button onClick={handleMergeImportedWorkflowPackage} type="button">
                    Merge into current package
                  </button>
                </div>
              </div>
            ) : null}

            <div className="workflow-import-actions">
              <button onClick={handleCloseWorkflowImportDialog} type="button">
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isWorkflowExportDialogOpen && workflowPackage ? (
        <WorkflowExportDialog
          exportableWorkflowIds={exportableWorkflowIds}
          onClose={handleCloseWorkflowExportDialog}
          onExport={handleExportWorkflowPackage}
          workflowPackage={workflowPackage}
        />
      ) : null}

      {isRunOrderDialogOpen && workflowPackage ? (
        <RunOrderDialog onApply={handleApplyRunOrder} onClose={handleCloseRunOrderDialog} workflowPackage={workflowPackage} />
      ) : null}

      {isAIDialogOpen ? (
        <AIAssistantModal
          aiDraft={activeAIState.draft}
          aiDraftDebugJson={aiDraftDebugJson}
          aiDraftIssues={activeAIState.draftIssues}
          aiDraftPreviewWorkflow={aiDraftPreviewWorkflow}
          aiDebugTrace={activeAIState.debugTrace}
          aiProgressEvents={activeAIState.progressEvents}
          aiError={activeAIState.error}
          aiMessages={activeAIState.messages}
          aiPromptValue={activeAIState.promptValue}
          aiSettings={aiSettings}
          canApplyDraft={Boolean(activeAIState.draft && activeAIState.draftIssues.length === 0 && activeWorkflow && !activeAIState.isLoading)}
          canDiscardDraft={Boolean(activeAIState.draft || activeAIState.draftIssues.length > 0)}
          canDownloadPrompt={canDownloadAIPrompt}
          canSendPrompt={Boolean(canUseAI && activeAIState.promptValue.trim() !== '' && !activeAIState.isLoading)}
          isLoading={activeAIState.isLoading}
          onApplyDraft={() => {
            void handleApplyAIDraft();
          }}
          onClose={handleCloseAIDialog}
          onDiscardDraft={handleDiscardAIDraft}
          onDownloadPrompt={handleDownloadAIPrompt}
          onPromptChange={(value) => {
            if (!activeWorkflowId) {
              return;
            }

            updateWorkflowAIState(activeWorkflowId, (state) => ({
              ...state,
              promptValue: value,
            }));
          }}
          onSendPrompt={() => {
            void handleSendAIPrompt();
          }}
          onSettingsChange={setAISettings}
          previewTable={aiDraftPreviewTable}
          workflowReady={canUseAI}
          workflowIssueNotice={aiWorkflowIssueNotice}
        />
      ) : null}
    </main>
  );
}

export function WorkflowTabs({
  activeWorkflowId,
  onCreateWorkflow,
  onDeleteWorkflow,
  onRenameWorkflow,
  onSelectWorkflow,
  onStartRenameHandled,
  startRenameWorkflowId,
  workflowTabStates,
  workflows,
}: {
  activeWorkflowId: string;
  onCreateWorkflow: () => void;
  onDeleteWorkflow: (workflowId: string) => void;
  onRenameWorkflow: (workflowId: string, nextName: string) => void;
  onSelectWorkflow: (workflowId: string) => void;
  onStartRenameHandled: () => void;
  startRenameWorkflowId: string | null;
  workflowTabStates: Record<string, WorkflowTabRuntimeState>;
  workflows: Workflow[];
}) {
  const [editingWorkflowId, setEditingWorkflowId] = useState<string | null>(null);
  const [draftWorkflowName, setDraftWorkflowName] = useState('');
  const [openMenuWorkflowId, setOpenMenuWorkflowId] = useState<string | null>(null);
  const [blurGuardedWorkflowId, setBlurGuardedWorkflowId] = useState<string | null>(null);
  const [blurGuardUntilMs, setBlurGuardUntilMs] = useState(0);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!openMenuWorkflowId) {
      return;
    }

    const handlePointerDown = () => {
      setOpenMenuWorkflowId(null);
    };

    window.addEventListener('pointerdown', handlePointerDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [openMenuWorkflowId]);

  useEffect(() => {
    if (!editingWorkflowId) {
      return;
    }

    const focusRenameInput = () => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    };

    const firstAnimationFrameId = window.requestAnimationFrame(() => {
      focusRenameInput();
    });
    const secondAnimationFrameId = window.requestAnimationFrame(() => {
      focusRenameInput();
    });
    const timeoutId = window.setTimeout(() => {
      focusRenameInput();
    }, 0);

    return () => {
      window.cancelAnimationFrame(firstAnimationFrameId);
      window.cancelAnimationFrame(secondAnimationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [editingWorkflowId]);

  useEffect(() => {
    if (!startRenameWorkflowId) {
      return;
    }

    const workflow = workflows.find((currentWorkflow) => currentWorkflow.workflowId === startRenameWorkflowId);

    if (!workflow) {
      return;
    }

    setOpenMenuWorkflowId(null);
    setEditingWorkflowId(workflow.workflowId);
    setDraftWorkflowName(workflow.name);
    setBlurGuardedWorkflowId(workflow.workflowId);
    setBlurGuardUntilMs(performance.now() + 350);
    onStartRenameHandled();
  }, [onStartRenameHandled, startRenameWorkflowId, workflows]);

  function beginRename(workflow: Workflow) {
    setOpenMenuWorkflowId(null);
    setEditingWorkflowId(workflow.workflowId);
    setDraftWorkflowName(workflow.name);
    setBlurGuardedWorkflowId(null);
    setBlurGuardUntilMs(0);
  }

  function cancelRename() {
    setEditingWorkflowId(null);
    setDraftWorkflowName('');
    setBlurGuardedWorkflowId(null);
    setBlurGuardUntilMs(0);
  }

  function handleRenameBlur(workflow: Workflow) {
    if (
      blurGuardedWorkflowId === workflow.workflowId
      && performance.now() < blurGuardUntilMs
    ) {
      window.requestAnimationFrame(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      });
      return;
    }

    commitRename(workflow);
  }

  function commitRename(workflow: Workflow) {
    const normalizedName = draftWorkflowName.trim();

    setEditingWorkflowId(null);
    setDraftWorkflowName('');
    setBlurGuardedWorkflowId(null);
    setBlurGuardUntilMs(0);

    if (normalizedName === '' || normalizedName === workflow.name) {
      return;
    }

    onRenameWorkflow(workflow.workflowId, normalizedName);
  }

  return (
    <div className="workflow-tab-strip" role="tablist" aria-label="Workflow tabs">
      {workflows.map((workflow) => {
        const isActive = workflow.workflowId === activeWorkflowId;
        const isEditing = workflow.workflowId === editingWorkflowId;
        const tabState = getWorkflowTabState(workflowTabStates, workflow.workflowId);
        const issueCount = tabState.editorIssues.length + tabState.validationIssues.length;

        return (
          <div className={`workflow-tab${isActive ? ' workflow-tab--active' : ''}${isEditing ? ' workflow-tab--editing' : ''}`} key={workflow.workflowId}>
            {isEditing ? (
              <input
                className="workflow-tab__input"
                onBlur={() => handleRenameBlur(workflow)}
                onChange={(event) => {
                  setDraftWorkflowName(event.target.value);
                  setBlurGuardedWorkflowId(null);
                  setBlurGuardUntilMs(0);
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitRename(workflow);
                  } else if (event.key === 'Escape') {
                    cancelRename();
                  }
                }}
                ref={isEditing ? renameInputRef : null}
                value={draftWorkflowName}
              />
            ) : (
              <button
                aria-selected={isActive}
                className="workflow-tab__button"
                onClick={() => onSelectWorkflow(workflow.workflowId)}
                onDoubleClick={() => beginRename(workflow)}
                role="tab"
                type="button"
              >
                <span className="workflow-tab__label">{workflow.name}</span>
                {issueCount > 0 ? <span className="workflow-tab__status" title={`${issueCount} issue${issueCount === 1 ? '' : 's'}`} /> : null}
              </button>
            )}
            <button
              aria-label={`Open workflow menu for ${workflow.name}`}
              className="workflow-tab__menu-trigger"
              onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                setOpenMenuWorkflowId((current) => (current === workflow.workflowId ? null : workflow.workflowId));
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              type="button"
            >
              <MenuIcon />
            </button>
            {openMenuWorkflowId === workflow.workflowId ? (
              <div
                className="workflow-tab__menu"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
              >
                <button
                  onClick={() => beginRename(workflow)}
                  type="button"
                >
                  Rename
                </button>
                <button
                  onClick={() => {
                    setOpenMenuWorkflowId(null);
                    onDeleteWorkflow(workflow.workflowId);
                  }}
                  type="button"
                >
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <button
        aria-label="Create workflow"
        className="workflow-tab workflow-tab--create"
        onClick={onCreateWorkflow}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        type="button"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function WorkflowExportDialog({
  exportableWorkflowIds,
  onClose,
  onExport,
  workflowPackage,
}: {
  exportableWorkflowIds: string[];
  onClose: () => void;
  onExport: (workflowIds: string[]) => void;
  workflowPackage: WorkflowPackageV1;
}) {
  const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>(exportableWorkflowIds);
  const exportableWorkflowIdSet = useMemo(() => new Set(exportableWorkflowIds), [exportableWorkflowIds]);

  useEffect(() => {
    setSelectedWorkflowIds(exportableWorkflowIds);
  }, [exportableWorkflowIds]);

  function toggleSelection(workflowId: string) {
    setSelectedWorkflowIds((current) =>
      current.includes(workflowId)
        ? current.filter((currentWorkflowId) => currentWorkflowId !== workflowId)
        : [...current, workflowId]);
  }

  return (
    <div className="workflow-import-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-export-title">
      <div className="workflow-import-modal__scrim" onClick={onClose} />
      <section className="workflow-import-modal__panel">
        <div className="panel-header">
          <div>
            <h2 id="workflow-export-title">Export workflow(s)</h2>
            <p>Select the workflows to include in the exported package JSON.</p>
          </div>
        </div>

        <div className="workflow-selection-list">
          {workflowPackage.workflows.map((workflow) => {
            const isExportable = exportableWorkflowIdSet.has(workflow.workflowId);
            const isSelected = selectedWorkflowIds.includes(workflow.workflowId);

            return (
              <label className={`workflow-selection-item${isExportable ? '' : ' workflow-selection-item--disabled'}`} key={workflow.workflowId}>
                <input
                  checked={isSelected}
                  disabled={!isExportable}
                  onChange={() => toggleSelection(workflow.workflowId)}
                  type="checkbox"
                />
                <div>
                  <strong>{workflow.name}</strong>
                  <span>{workflow.workflowId}</span>
                </div>
              </label>
            );
          })}
        </div>

        <div className="workflow-import-actions workflow-import-actions--spread">
          <div className="workflow-import-actions">
            <button onClick={() => setSelectedWorkflowIds(exportableWorkflowIds)} type="button">
              Select all valid
            </button>
            <button onClick={() => setSelectedWorkflowIds([])} type="button">
              Clear
            </button>
          </div>
          <div className="workflow-import-actions">
            <button onClick={onClose} type="button">
              Close
            </button>
            <button disabled={selectedWorkflowIds.length === 0} onClick={() => onExport(selectedWorkflowIds)} type="button">
              Export selected
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function RunOrderDialog({
  onApply,
  onClose,
  workflowPackage,
}: {
  onApply: (workflowIds: string[]) => void;
  onClose: () => void;
  workflowPackage: WorkflowPackageV1;
}) {
  const [draftRunOrderWorkflowIds, setDraftRunOrderWorkflowIds] = useState<string[]>(workflowPackage.runOrderWorkflowIds);

  useEffect(() => {
    setDraftRunOrderWorkflowIds(workflowPackage.runOrderWorkflowIds);
  }, [workflowPackage.runOrderWorkflowIds]);

  const workflowById = useMemo(
    () => new Map(workflowPackage.workflows.map((workflow) => [workflow.workflowId, workflow] as const)),
    [workflowPackage.workflows],
  );
  const includedWorkflowIdSet = new Set(draftRunOrderWorkflowIds);
  const orderedWorkflows = [
    ...draftRunOrderWorkflowIds
      .map((workflowId) => workflowById.get(workflowId))
      .filter((workflow): workflow is Workflow => Boolean(workflow)),
    ...workflowPackage.workflows.filter((workflow) => !includedWorkflowIdSet.has(workflow.workflowId)),
  ];

  function toggleIncluded(workflowId: string) {
    setDraftRunOrderWorkflowIds((current) =>
      current.includes(workflowId)
        ? current.filter((currentWorkflowId) => currentWorkflowId !== workflowId)
        : [...current, workflowId]);
  }

  function moveWorkflow(workflowId: string, direction: -1 | 1) {
    setDraftRunOrderWorkflowIds((current) => {
      const index = current.indexOf(workflowId);

      if (index < 0) {
        return current;
      }

      const targetIndex = index + direction;

      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [movedWorkflowId] = next.splice(index, 1);

      next.splice(targetIndex, 0, movedWorkflowId);
      return next;
    });
  }

  return (
    <div className="workflow-import-modal" role="dialog" aria-modal="true" aria-labelledby="run-order-title">
      <div className="workflow-import-modal__scrim" onClick={onClose} />
      <section className="workflow-import-modal__panel">
        <div className="panel-header">
          <div>
            <h2 id="run-order-title">Run order</h2>
            <p>Select which workflows belong to the saved sequence and arrange their execution order.</p>
          </div>
        </div>

        <div className="workflow-selection-list">
          {orderedWorkflows.map((workflow) => {
            const sequenceIndex = draftRunOrderWorkflowIds.indexOf(workflow.workflowId);
            const isIncluded = sequenceIndex >= 0;

            return (
              <div className="workflow-selection-item workflow-selection-item--row" key={workflow.workflowId}>
                <label className="workflow-selection-item__main">
                  <input
                    checked={isIncluded}
                    onChange={() => toggleIncluded(workflow.workflowId)}
                    type="checkbox"
                  />
                  <div>
                    <strong>{workflow.name}</strong>
                  </div>
                </label>
                <div className="workflow-selection-item__actions">
                  <button disabled={!isIncluded || sequenceIndex === 0} onClick={() => moveWorkflow(workflow.workflowId, -1)} type="button">
                    Move up
                  </button>
                  <button
                    disabled={!isIncluded || sequenceIndex === draftRunOrderWorkflowIds.length - 1}
                    onClick={() => moveWorkflow(workflow.workflowId, 1)}
                    type="button"
                  >
                    Move down
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="workflow-import-actions">
          <button onClick={onClose} type="button">
            Close
          </button>
          <button onClick={() => onApply(draftRunOrderWorkflowIds)} type="button">
            Save run order
          </button>
        </div>
      </section>
    </div>
  );
}

function SchemaPanel({ table }: { table: Table }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Schema</h2>
        <p>Normalized headers and inferred logical types.</p>
      </div>
      <div className="table-frame table-frame--panel-scroll" style={{ maxHeight: `${COLLAPSIBLE_PANEL_MAX_HEIGHT_PX}px` }}>
        <table className="data-table data-table--compact">
          <thead>
            <tr>
              <th>Display name</th>
              <th>Column ID</th>
              <th>Type</th>
              <th>Missing count</th>
            </tr>
          </thead>
          <tbody>
            {table.schema.columns.map((column) => (
              <tr key={column.columnId}>
                <td>{column.displayName}</td>
                <td>
                  <code>{column.columnId}</code>
                </td>
                <td>{column.logicalType}</td>
                <td>{column.missingCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WarningsPanel({ warnings }: { warnings: ImportWarning[] }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Import warnings</h2>
        <p>Notable normalization and workbook import events.</p>
      </div>
      {warnings.length === 0 ? (
        <div className="empty-panel">No import warnings.</div>
      ) : (
        <div className="panel-scroll-region" style={{ maxHeight: `${COLLAPSIBLE_PANEL_MAX_HEIGHT_PX}px` }}>
          <ul className="warning-list">
            {warnings.map((warning, index) => (
              <li className="warning-item" key={`${warning.code}-${warning.tableId ?? 'workbook'}-${warning.columnId ?? 'all'}-${index}`}>
                <div className="warning-code">{warning.code}</div>
                <div>
                  <p>{warning.message}</p>
                  <small>{warning.scope}</small>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ValidationPanel({
  issues,
  jsonError,
}: {
  issues: Array<{ code: string; message: string }>;
  jsonError: string | null;
}) {
  const issueCount = issues.length + (jsonError ? 1 : 0);

  return (
    <section className="panel panel--compact">
      <div className="panel-header panel-header--compact">
        <h2>Validation</h2>
        <p>{issueCount === 0 ? 'No issues' : `${issueCount} issue${issueCount === 1 ? '' : 's'}`}</p>
      </div>
      {jsonError ? <pre className="json-error-panel">{jsonError}</pre> : null}
      {issues.length === 0 ? (
        <div className="empty-panel empty-panel--compact">No current workflow issues.</div>
      ) : (
        <div className="panel-scroll-region" style={{ maxHeight: '13rem' }}>
          <ul className="issue-list issue-list--compact">
          {issues.map((issue, index) => (
              <li className="issue-item issue-item--compact" key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong>
              <p>{issue.message}</p>
            </li>
          ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RunResultPanel({
  executionResult,
  onExportCsv,
  onExportXlsx,
  runContext,
}: {
  executionResult: WorkflowExecutionResult | null;
  onExportCsv: () => void;
  onExportXlsx: () => void;
  runContext: RunExecutionContext | null;
}) {
  if (!executionResult) {
    return null;
  }

  const canExport = Boolean(executionResult && executionResult.validationErrors.length === 0 && executionResult.transformedTable);

  return (
    <section className="panel panel--compact">
      <div className="panel-header">
        <div>
          <h2>Run summary</h2>
          <p>
            {runContext
              ? runContext.kind === 'sequence'
                ? `Sequence: ${runContext.workflowNames.join(' -> ')}`
                : `Workflow: ${runContext.workflowNames[0] ?? 'Workflow'}`
              : 'Compact metadata for the latest workflow run.'}
          </p>
        </div>
        {canExport ? (
          <div className="export-actions export-actions--compact">
            <button onClick={onExportCsv} type="button">
              Export CSV
            </button>
            <button onClick={onExportXlsx} type="button">
              Export XLSX
            </button>
          </div>
        ) : null}
      </div>
      {executionResult.validationErrors.length > 0 ? (
        <div className="empty-panel">Run blocked by validation errors.</div>
      ) : (
        <dl className="result-stats result-stats--compact">
          <div>
            <dt>Changed rows</dt>
            <dd>{executionResult.changedRowCount}</dd>
          </div>
          <div>
            <dt>Changed cells</dt>
            <dd>{executionResult.changedCellCount}</dd>
          </div>
          <div>
            <dt>Removed rows</dt>
            <dd>{executionResult.removedRowCount}</dd>
          </div>
          <div>
            <dt>Created columns</dt>
            <dd>{executionResult.createdColumnIds.length > 0 ? executionResult.createdColumnIds.join(', ') : 'None'}</dd>
          </div>
          <div>
            <dt>Row order changed</dt>
            <dd>{executionResult.rowOrderChanged ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Sort applied</dt>
            <dd>{executionResult.sortApplied ? 'yes' : 'no'}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function AIAssistantModal({
  aiDraft,
  aiDraftDebugJson,
  aiDraftIssues,
  aiDraftPreviewWorkflow,
  aiDebugTrace,
  aiProgressEvents,
  aiError,
  aiMessages,
  aiPromptValue,
  aiSettings,
  canApplyDraft,
  canDiscardDraft,
  canDownloadPrompt,
  canSendPrompt,
  isLoading,
  onApplyDraft,
  onClose,
  onDiscardDraft,
  onDownloadPrompt,
  onPromptChange,
  onSendPrompt,
  onSettingsChange,
  previewTable,
  workflowReady,
  workflowIssueNotice,
}: {
  aiDraft: AIDraft | null;
  aiDraftDebugJson: string;
  aiDraftIssues: AIDraftIssue[];
  aiDraftPreviewWorkflow: Workflow | null;
  aiDebugTrace: AIDebugTrace | null;
  aiProgressEvents: AIProgressEvent[];
  aiError: string | null;
  aiMessages: AIMessage[];
  aiPromptValue: string;
  aiSettings: AISettings;
  canApplyDraft: boolean;
  canDiscardDraft: boolean;
  canDownloadPrompt: boolean;
  canSendPrompt: boolean;
  isLoading: boolean;
  onApplyDraft: () => void;
  onClose: () => void;
  onDiscardDraft: () => void;
  onDownloadPrompt: () => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onSettingsChange: (settings: AISettings) => void;
  previewTable: Table | null;
  workflowReady: boolean;
  workflowIssueNotice: string | null;
}) {
  const [isDraftPreviewOpen, setIsDraftPreviewOpen] = useState(false);
  const chatLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isDraftPreviewOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDraftPreviewOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isDraftPreviewOpen]);

  useEffect(() => {
    const container = chatLogRef.current;

    if (!container) {
      return;
    }

    container.scrollTop = container.scrollHeight;
  }, [aiMessages, isLoading]);

  return (
    <div className="workflow-import-modal" role="dialog" aria-modal="true" aria-labelledby="ai-assistant-title">
      <div className="workflow-import-modal__scrim" onClick={onClose} />
      <section className="workflow-import-modal__panel ai-assistant-modal__panel">
        <div className="panel-header">
          <div>
            <h2 id="ai-assistant-title">Ask AI</h2>
            <p>Describe the next workflow steps in natural language. The assistant builds a separate draft and only updates the live workflow when you apply it.</p>
          </div>
        </div>

        <div className="ai-assistant-settings">
          <label className="workflow-meta-field">
            <span>Gemini API key</span>
            <input
              onChange={(event) =>
                onSettingsChange({
                  ...aiSettings,
                  apiKey: event.target.value,
                })
              }
              placeholder="Paste your Gemini API key"
              type="password"
              value={aiSettings.apiKey}
            />
          </label>
          <label className="workflow-meta-field">
            <span>Model</span>
            <select
              onChange={(event) =>
                onSettingsChange({
                  ...aiSettings,
                  model: event.target.value,
                })
              }
              value={aiSettings.model}
            >
              {GEMINI_MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="workflow-meta-field">
            <span>Thinking mode</span>
            <div className="ai-assistant-toggle">
              <input
                checked={aiSettings.thinkingEnabled}
                onChange={(event) =>
                  onSettingsChange({
                    ...aiSettings,
                    thinkingEnabled: event.target.checked,
                  })
                }
                type="checkbox"
              />
              <div className="ai-assistant-toggle__body">
                <strong>{aiSettings.thinkingEnabled ? 'Enabled' : 'Disabled'}</strong>
                <small>{describeAIThinkingMode(aiSettings.model, aiSettings.thinkingEnabled)}</small>
              </div>
            </div>
          </label>
        </div>

        {!workflowReady ? <div className="empty-panel">Load a table and workflow before asking AI to draft workflow changes.</div> : null}
        {workflowIssueNotice ? <div className="empty-panel">{workflowIssueNotice}</div> : null}
        {aiError ? <pre className="json-error-panel">{aiError}</pre> : null}

        <div className="ai-assistant-layout">
          <section className="ai-assistant-panel ai-assistant-panel--conversation">
            <div className="panel-header">
              <div>
                <h2>Conversation</h2>
                <p>The assistant can clarify ambiguous requests before proposing a draft workflow.</p>
              </div>
            </div>

            <div className="ai-chat-log" ref={chatLogRef}>
              {aiMessages.length === 0 ? (
                <div className="empty-panel">Start with a natural-language request like "remove rows with invalid emails".</div>
              ) : (
                aiMessages.map((message, index) => (
                  <article className={`ai-chat-message ai-chat-message--${message.role}`} key={`${message.timestamp}-${index}`}>
                    <strong>{message.role === 'assistant' ? 'AI' : 'You'}</strong>
                    <p>{message.text}</p>
                  </article>
                ))
              )}
            </div>

            <div className="ai-assistant-compose">
              <textarea
                className="json-viewer ai-assistant-compose__input"
                onChange={(event) => onPromptChange(event.target.value)}
                placeholder="Describe the workflow changes you want"
                value={aiPromptValue}
              />
              <div className="workflow-import-actions">
                <button disabled={!canDownloadPrompt} onClick={onDownloadPrompt} type="button">
                  Download prompt
                </button>
                <button disabled={!canSendPrompt} onClick={onSendPrompt} type="button">
                  {isLoading ? 'Working...' : 'Send'}
                </button>
              </div>
            </div>
          </section>

          <section className="ai-assistant-panel ai-assistant-panel--draft">
            <div className="panel-header">
              <div>
                <h2>Draft</h2>
                <p>Preview the full workflow that would exist after applying the current AI draft.</p>
              </div>
            </div>

            {aiDraft ? (
              <div className="ai-draft-summary">
                <strong>{formatAIDraftSummary(aiDraft)}</strong>
                <p>{aiDraft.assistantMessage}</p>
                {aiDraft.kind === 'workflowSet' ? (
                  <div className="ai-draft-preview-note">
                    <p>Apply mode: {formatWorkflowSetApplyMode(aiDraft.applyMode)}</p>
                    <p>Run order: {formatWorkflowSetRunOrder(aiDraft)}</p>
                  </div>
                ) : null}
                <p className="ai-draft-preview-note">Open a fullscreen, read-only Blockly view to inspect the full workflow after applying this draft.</p>
                {aiDraft.assumptions.length > 0 ? (
                  <ul className="issue-list">
                    {aiDraft.assumptions.map((assumption, index) => (
                      <li className="issue-item" key={`${assumption}-${index}`}>
                        <strong>Assumption</strong>
                        <p>{assumption}</p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <div className="empty-panel">No accepted draft yet.</div>
            )}

            {aiDraftIssues.length > 0 ? (
              <ul className="issue-list">
                {aiDraftIssues.map((issue, index) => (
                  <li className="issue-item" key={`${issue.code}-${issue.path}-${index}`}>
                    <strong>{issue.code}</strong>
                    <p>{issue.message}</p>
                  </li>
                ))}
              </ul>
            ) : null}

            {aiDraft && aiDraftPreviewWorkflow && previewTable ? (
              <div className="workflow-import-actions ai-draft-actions">
                <button
                  onClick={() => {
                    setIsDraftPreviewOpen(true);
                  }}
                  type="button"
                >
                  Show draft
                </button>
              </div>
            ) : null}

            <details className="ai-debug-trace">
              <summary>Activity log</summary>
              <div className="ai-debug-trace__section">
                <p className="ai-debug-trace__note">Live client-side AI turn stages. These are mirrored to the browser console as <code>[AI]</code> logs and, in dev mode, appended to <code>.logs/ai-debug.log</code>.</p>
                {aiProgressEvents.length === 0 ? (
                  <div className="empty-panel empty-panel--compact">No AI activity yet.</div>
                ) : (
                  <ul className="ai-activity-log">
                    {aiProgressEvents.map((event, index) => (
                      <li className="ai-activity-log__item" key={`${event.timestamp}-${event.stage}-${index}`}>
                        <strong>{formatTime(event.timestamp)}</strong>
                        <span>{event.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </details>

            {aiDraft ? (
              <details className="ai-debug-trace ai-draft-debug">
                <summary>Draft JSON</summary>
                <div className="ai-debug-trace__section">
                  <strong>{aiDraft.kind === 'workflowSet' ? 'Canonical workflow-set draft' : 'Canonical replacement steps'}</strong>
                  <textarea className="json-viewer ai-draft-debug__viewer" readOnly value={aiDraftDebugJson} />
                </div>
              </details>
            ) : null}

            {aiDebugTrace ? (
              <details className="ai-debug-trace">
                <summary>AI debug trace</summary>
                <dl className="result-stats ai-debug-trace__stats">
                  <div>
                    <dt>Outcome</dt>
                    <dd>{aiDebugTrace.outcomeKind}</dd>
                  </div>
                  <div>
                    <dt>Repaired</dt>
                    <dd>{aiDebugTrace.repaired ? 'yes' : 'no'}</dd>
                  </div>
                  <div>
                    <dt>Initial mode</dt>
                    <dd>{aiDebugTrace.initialResponse.mode}</dd>
                  </div>
                  <div>
                    <dt>Repair attempts</dt>
                    <dd>{aiDebugTrace.repairAttempts.length}</dd>
                  </div>
                </dl>
                <div className="ai-debug-trace__section">
                  <strong>Initial parsed authoring response</strong>
                  <textarea
                    className="json-viewer ai-debug-trace__viewer"
                    readOnly
                    value={`${JSON.stringify(aiDebugTrace.initialResponse, null, 2)}\n`}
                  />
                </div>
                <div className="ai-debug-trace__section">
                  <strong>Initial raw response</strong>
                  <textarea className="json-viewer ai-debug-trace__viewer" readOnly value={aiDebugTrace.initialRawText} />
                </div>
                {aiDebugTrace.initialCompiledDraft ? (
                  <div className="ai-debug-trace__section">
                    <strong>Initial compiled canonical draft</strong>
                    <textarea
                      className="json-viewer ai-debug-trace__viewer"
                      readOnly
                      value={`${JSON.stringify(aiDebugTrace.initialCompiledDraft, null, 2)}\n`}
                    />
                  </div>
                ) : null}
                {aiDebugTrace.initialCompilationIssues.length > 0 ? (
                  <div className="ai-debug-trace__section">
                    <strong>Initial compiler issues</strong>
                    <textarea
                      className="json-viewer ai-debug-trace__viewer"
                      readOnly
                      value={`${JSON.stringify(aiDebugTrace.initialCompilationIssues, null, 2)}\n`}
                    />
                  </div>
                ) : null}
                {aiDebugTrace.initialValidationIssues.length > 0 ? (
                  <div className="ai-debug-trace__section">
                    <strong>Initial validation issues</strong>
                    <textarea
                      className="json-viewer ai-debug-trace__viewer"
                      readOnly
                      value={`${JSON.stringify(aiDebugTrace.initialValidationIssues, null, 2)}\n`}
                    />
                  </div>
                ) : null}
                {aiDebugTrace.repairAttempts.map((attempt) => (
                  <div className="ai-debug-trace__section" key={attempt.attempt}>
                    <strong>{`Repair attempt ${attempt.attempt}`}</strong>
                    <textarea
                      className="json-viewer ai-debug-trace__viewer"
                      readOnly
                      value={`${JSON.stringify(
                        {
                          repairPromptIssues: attempt.repairPromptIssues,
                          response: attempt.response,
                          rawText: attempt.rawText,
                          compiledDraft: attempt.compiledDraft ?? null,
                          compilationIssues: attempt.compilationIssues,
                          validationIssues: attempt.validationIssues,
                        },
                        null,
                        2,
                      )}\n`}
                    />
                  </div>
                ))}
              </details>
            ) : null}
          </section>
        </div>

        <div className="workflow-import-actions">
          <button disabled={!canDiscardDraft} onClick={onDiscardDraft} type="button">
            Discard draft
          </button>
          <button onClick={onClose} type="button">
            Close
          </button>
          <button disabled={!canApplyDraft} onClick={onApplyDraft} type="button">
            Apply draft
          </button>
        </div>
      </section>

      {isDraftPreviewOpen && aiDraftPreviewWorkflow && previewTable ? (
        <div className="workflow-import-modal workflow-block-preview-modal" role="dialog" aria-modal="true" aria-labelledby="draft-preview-title">
          <div
            className="workflow-import-modal__scrim"
            onClick={() => {
              setIsDraftPreviewOpen(false);
            }}
          />
          <section className="workflow-import-modal__panel workflow-block-preview-modal__panel">
            <div className="panel-header">
              <div>
                <h2 id="draft-preview-title">Draft preview</h2>
                <p>Read-only block view of the full workflow after applying the current AI draft.</p>
              </div>
              <div className="workflow-import-actions">
                <button
                  onClick={() => {
                    setIsDraftPreviewOpen(false);
                  }}
                  type="button"
                >
                  Close
                </button>
                <button disabled={!canApplyDraft} onClick={onApplyDraft} type="button">
                  Apply draft
                </button>
              </div>
            </div>

            <WorkflowBlockPreview table={previewTable} workflow={aiDraftPreviewWorkflow} />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  allowFullscreen = false,
  headerControls,
  table,
  previewRows,
  title,
  description,
}: {
  allowFullscreen?: boolean;
  headerControls?: ReactNode;
  table: Table;
  previewRows: ReturnType<typeof getOrderedRows>;
  title: string;
  description: string;
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = 'hidden';

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isFullscreen]);

  return (
    <section className={`panel panel--full preview-panel${isFullscreen ? ' preview-panel--fullscreen' : ''}`}>
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {headerControls || allowFullscreen ? (
          <div className="panel-header-actions">
            {headerControls}
            {allowFullscreen ? (
              <button
                aria-label={isFullscreen ? `Exit fullscreen ${title.toLowerCase()}` : `Open fullscreen ${title.toLowerCase()}`}
                className="preview-panel-fullscreen"
                onClick={() => {
                  setIsFullscreen((current) => !current);
                }}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                type="button"
              >
                <span aria-hidden="true" className="preview-panel-fullscreen__icon">
                  {isFullscreen ? <CollapseIcon /> : <FullscreenIcon />}
                </span>
                <span>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="table-frame table-frame--preview">
        <table className="data-table">
          <thead>
            <tr>
              <th>Row ID</th>
              {table.schema.columns.map((column) => (
                <th key={column.columnId}>
                  <div className="column-heading">
                    <span>{column.displayName}</span>
                    <small>{column.columnId}</small>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row) => (
              <tr key={row.rowId}>
                <td>
                  <code>{row.rowId}</code>
                </td>
                {table.schema.columns.map((column) => {
                  const fillColor = getCellStyle(row, column.columnId)?.fillColor;

                  return (
                    <td
                      key={`${row.rowId}-${column.columnId}`}
                      style={fillColor ? { backgroundColor: fillColor, color: getReadableTextColor(fillColor) } : undefined}
                    >
                      {formatCellValue(row.cellsByColumnId[column.columnId])}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M6 12h0.01" />
      <path d="M12 12h0.01" />
      <path d="M18 12h0.01" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function mergeWorkflowIssues(editorIssues: EditorIssue[], validationIssues: WorkflowValidationIssue[]) {
  return [
    ...editorIssues.map((issue) => ({
      code: issue.code,
      message: issue.message,
    })),
    ...validationIssues.map((issue) => ({
      code: issue.code,
      message: issue.message,
    })),
  ];
}

function buildWorkflowIssueDisplayItems(
  editorIssues: EditorIssue[],
  validationIssues: WorkflowValidationIssue[],
  stepBlockIdsByStepId: StepBlockIdsByStepId,
): ValidationDisplayItem[] {
  return [
    ...editorIssues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.blockId ? { targetBlockId: issue.blockId } : {}),
    })),
    ...validationIssues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.stepId && stepBlockIdsByStepId[issue.stepId]
        ? { targetBlockId: stepBlockIdsByStepId[issue.stepId] }
        : {}),
    })),
  ];
}

function formatCellValue(value: Table['rowsById'][string]['cellsByColumnId'][string]) {
  if (value === null) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildAIPromptExportFileName(workflow: Workflow) {
  const baseName = workflow.workflowId.trim() || 'workflow';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${baseName}-ai-prompt-${timestamp}.json`;
}

function readStoredValue(key: string) {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(key) ?? '';
}

function readStoredBoolean(key: string) {
  return readStoredValue(key) === 'true';
}

function describeAIThinkingMode(model: string, thinkingEnabled: boolean) {
  const normalizedModel = normalizeGeminiModelSelection(model);

  if (normalizedModel.startsWith('gemini-3')) {
    return thinkingEnabled
      ? 'On uses Gemini 3 high thinking. Expect higher latency and more billed output tokens.'
      : 'Off uses Gemini 3 minimal thinking. Google notes the model may still think a little on harder prompts.';
  }

  return thinkingEnabled
    ? 'On enables dynamic thinking. Expect higher latency and more billed output tokens.'
    : 'Off disables thinking to keep drafting faster and cheaper.';
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createAITurnId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `ai-turn-${Date.now()}`;
}

function logGeminiClientEvent(turnId: string, event: GeminiClientLogEvent) {
  const prefix = `[AI][${event.phase}] ${event.kind}`;

  if (event.rawText) {
    console.info(`${prefix}: ${event.message}`, event.rawText);
  } else if (event.error || event.responseBody || event.requestExport) {
    console.warn(`${prefix}: ${event.message}`, {
      ...(event.error ? { error: event.error } : {}),
      ...(typeof event.statusCode === 'number' ? { statusCode: event.statusCode } : {}),
      ...(event.responseBody ? { responseBody: event.responseBody } : {}),
      ...(event.requestExport ? { requestExport: event.requestExport } : {}),
    });
  } else {
    console.info(`${prefix}: ${event.message}`);
  }

  void appendAIDevLog({
    turnId,
    kind: 'gemini_client',
    phase: event.phase,
    eventKind: event.kind,
    message: event.message,
    timestamp: event.timestamp,
    ...(event.responseMode ? { responseMode: event.responseMode } : {}),
    ...(event.rawText ? { rawText: event.rawText } : {}),
    ...(event.error ? { error: event.error } : {}),
    ...(event.requestExport ? { requestExport: event.requestExport } : {}),
    ...(typeof event.statusCode === 'number' ? { statusCode: event.statusCode } : {}),
    ...(event.responseBody ? { responseBody: event.responseBody } : {}),
  });
}
