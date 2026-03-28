import { ChangeEvent, DragEvent, startTransition, useDeferredValue, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  WorkflowEditor,
  collectWorkflowColumnIds,
  createDefaultWorkflow,
  parseWorkflowJson,
  type EditorIssue,
  workflowToJson,
} from './editor';
import { executeWorkflow, validateWorkflowSemantics, validateWorkflowStructure, type Workflow, type WorkflowExecutionResult, type WorkflowValidationIssue } from './workflow';
import type { ValidationWorkerResponse, ValidationWorkerTableSnapshot } from './workflow/validationWorker';
import { getActiveTable, getOrderedRows, setActiveTable, type ImportWarning, type Table, type Workbook } from './domain/model';
import {
  buildCsvExportFileName,
  buildXlsxExportFileName,
  exportTableCsvBlob,
  exportTableXlsxBlob,
  importWorkbookFromFile,
} from './domain/workbookIO';

const PREVIEW_ROW_LIMIT = 50;
const COLLAPSIBLE_PANEL_MAX_HEIGHT_PX = 320;

export default function App() {
  const uploadDragDepthRef = useRef(0);
  const workflowImportInputRef = useRef<HTMLInputElement | null>(null);
  const workflowImportDragDepthRef = useRef(0);
  const validationDebounceTimerRef = useRef<number | null>(null);
  const validationWorkerRef = useRef<Worker | null>(null);
  const validationRequestIdRef = useRef(0);
  const [workbook, setWorkbookState] = useState<Workbook | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploadDragActive, setIsUploadDragActive] = useState(false);
  const [authoredWorkflow, setAuthoredWorkflow] = useState<Workflow | null>(null);
  const [editorIssues, setEditorIssues] = useState<EditorIssue[]>([]);
  const [validationIssues, setValidationIssues] = useState<WorkflowValidationIssue[]>([]);
  const [loadWorkflow, setLoadWorkflow] = useState<Workflow | null>(null);
  const [workflowLoadVersion, setWorkflowLoadVersion] = useState(0);
  const [workflowJsonError, setWorkflowJsonError] = useState<string | null>(null);
  const [isWorkflowImportDialogOpen, setIsWorkflowImportDialogOpen] = useState(false);
  const [workflowImportMode, setWorkflowImportMode] = useState<'choice' | 'paste'>('choice');
  const [workflowImportPasteValue, setWorkflowImportPasteValue] = useState('');
  const [isWorkflowImportDragActive, setIsWorkflowImportDragActive] = useState(false);
  const [executionResult, setExecutionResult] = useState<WorkflowExecutionResult | null>(null);

  const activeTable = getActiveTable(workbook);
  const previewRows = activeTable ? getOrderedRows(activeTable).slice(0, PREVIEW_ROW_LIMIT) : [];
  const resultTable = executionResult?.transformedTable ?? null;
  const resultPreviewRows = resultTable ? getOrderedRows(resultTable).slice(0, PREVIEW_ROW_LIMIT) : [];
  const deferredAuthoredWorkflow = useDeferredValue(authoredWorkflow);
  const authoredWorkflowJson = deferredAuthoredWorkflow ? workflowToJson(deferredAuthoredWorkflow) : '';

  useEffect(() => {
    const cancelScheduledValidation = () => {
      if (validationDebounceTimerRef.current !== null) {
        window.clearTimeout(validationDebounceTimerRef.current);
        validationDebounceTimerRef.current = null;
      }

      if (validationWorkerRef.current) {
        validationWorkerRef.current.terminate();
        validationWorkerRef.current = null;
      }
    };

    cancelScheduledValidation();

    if (!activeTable || !authoredWorkflow || editorIssues.length > 0) {
      setValidationIssues([]);
      return cancelScheduledValidation;
    }

    const tableSnapshot: ValidationWorkerTableSnapshot = {
      tableId: activeTable.tableId,
      sourceName: activeTable.sourceName,
      schema: {
        columns: activeTable.schema.columns.map((column) => ({ ...column })),
      },
    };
    const requestId = validationRequestIdRef.current + 1;

    validationRequestIdRef.current = requestId;

    validationDebounceTimerRef.current = window.setTimeout(() => {
      validationDebounceTimerRef.current = null;
      const worker = new Worker(new URL('./workflow/validation.worker.ts', import.meta.url), { type: 'module' });

      validationWorkerRef.current = worker;

      worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
        if (event.data.requestId !== validationRequestIdRef.current) {
          return;
        }

        startTransition(() => {
          setValidationIssues(event.data.issues);
        });

        worker.terminate();

        if (validationWorkerRef.current === worker) {
          validationWorkerRef.current = null;
        }
      };

      worker.onerror = () => {
        worker.terminate();

        if (validationWorkerRef.current === worker) {
          validationWorkerRef.current = null;
        }
      };

      worker.postMessage({
        requestId,
        workflow: authoredWorkflow,
        table: tableSnapshot,
      });
    }, 150);

    return cancelScheduledValidation;
  }, [activeTable, authoredWorkflow, editorIssues]);

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
        resetWorkflowEditor(createDefaultWorkflow(importedTable));
      } else {
        resetWorkflowEditor(null);
      }
    } catch (caughtError) {
      setWorkbookState(null);
      resetWorkflowEditor(null);
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
  }

  function handleEditorWorkspaceChange(result: { workflow: Workflow | null; issues: EditorIssue[] }) {
    startTransition(() => {
      setAuthoredWorkflow(result.workflow);
      setEditorIssues(result.issues);
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
    if (!activeTable || !authoredWorkflow) {
      return;
    }

    setExecutionResult(executeWorkflow(authoredWorkflow, activeTable));
  }

  function handleExportWorkflowJson() {
    if (!authoredWorkflow) {
      return;
    }

    downloadBlob(new Blob([authoredWorkflowJson], { type: 'application/json;charset=utf-8' }), `${authoredWorkflow.workflowId || 'workflow'}.json`);
  }

  async function handleImportWorkflowJsonFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    await importWorkflowJsonFile(file);
    event.target.value = '';
  }

  async function importWorkflowJsonFile(file: File) {
    await importWorkflowJsonText(await file.text());
  }

  async function importWorkflowJsonText(text: string) {
    const parsed = parseWorkflowJson(text);

    if (!parsed.workflow) {
      setWorkflowJsonError(parsed.issues.map((issue) => issue.message).join('\n'));
      return false;
    }

    setWorkflowJsonError(null);
    setExecutionResult(null);
    setLoadWorkflow(parsed.workflow);
    setWorkflowLoadVersion((version) => version + 1);
    setIsWorkflowImportDialogOpen(false);
    setWorkflowImportMode('choice');
    setWorkflowImportPasteValue('');
    return true;
  }

  function handleOpenWorkflowImportDialog() {
    setWorkflowImportMode('choice');
    setWorkflowImportPasteValue('');
    setWorkflowJsonError(null);
    workflowImportDragDepthRef.current = 0;
    setIsWorkflowImportDragActive(false);
    setIsWorkflowImportDialogOpen(true);
  }

  function handleCloseWorkflowImportDialog() {
    setWorkflowImportMode('choice');
    setWorkflowImportPasteValue('');
    workflowImportDragDepthRef.current = 0;
    setIsWorkflowImportDragActive(false);
    setIsWorkflowImportDialogOpen(false);
  }

  function handleChooseWorkflowImportFile() {
    workflowImportInputRef.current?.click();
  }

  async function handleImportWorkflowPaste() {
    await importWorkflowJsonText(workflowImportPasteValue);
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

    await importWorkflowJsonFile(file);
  }

  function resetWorkflowEditor(nextWorkflow: Workflow | null) {
    setAuthoredWorkflow(nextWorkflow);
    setEditorIssues([]);
    setValidationIssues([]);
    setLoadWorkflow(nextWorkflow);
    setWorkflowLoadVersion((version) => version + 1);
    setWorkflowJsonError(null);
    setExecutionResult(null);
  }

  const visibleWarnings = workbook && activeTable ? [...workbook.importWarnings, ...activeTable.importWarnings] : [];
  const allWorkflowIssues = mergeWorkflowIssues(editorIssues, validationIssues);
  const workflowExtraColumnIds = deferredAuthoredWorkflow ? collectWorkflowColumnIds(deferredAuthoredWorkflow) : [];
  const canRunWorkflow = Boolean(activeTable && authoredWorkflow && editorIssues.length === 0 && validationIssues.length === 0);

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Selection-first authoring</p>
          <h1>Scratch My Table</h1>
          <p className="hero-copy">
            Import one table, author V1 workflows as compact scope-and-expression steps, validate them against the active schema, and run them through the existing executor.
          </p>
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

          <section className="editor-layout">
            <section className="panel panel--editor">
              <div className="panel-header">
                <div>
                  <h2>Workflow editor</h2>
                  <p>Select columns, optionally scope rows, then apply an expression. The canonical workflow IR remains the runtime source of truth.</p>
                </div>
                <div className="workflow-actions">
                  <button disabled={!authoredWorkflow} onClick={handleExportWorkflowJson} type="button">
                    Export workflow JSON
                  </button>
                  <button onClick={handleOpenWorkflowImportDialog} type="button">
                    Import workflow JSON
                  </button>
                  <button disabled={!canRunWorkflow} onClick={handleRunWorkflow} type="button">
                    Run workflow
                  </button>
                </div>
              </div>

              <WorkflowEditor
                extraColumnIds={workflowExtraColumnIds}
                loadVersion={workflowLoadVersion}
                loadWorkflow={loadWorkflow}
                onWorkspaceChange={handleEditorWorkspaceChange}
                table={activeTable}
              />
            </section>

            <section className="panel-stack">
              <ValidationPanel issues={allWorkflowIssues} jsonError={workflowJsonError} />
              <WorkflowJsonPanel workflowJson={authoredWorkflowJson} />
              <RunResultPanel
                executionResult={executionResult}
                onExportCsv={() => {
                  handleExportTableCsv(resultTable);
                }}
                onExportXlsx={() => {
                  handleExportTableXlsx(resultTable);
                }}
              />
            </section>
          </section>

          {resultTable ? (
            <PreviewPanel
              description={`Showing ${resultPreviewRows.length} of ${resultTable.rowOrder.length} transformed rows.`}
              previewRows={resultPreviewRows}
              table={resultTable}
              title="Run result"
            />
          ) : null}
        </>
      )}

      <input
        accept=".json,application/json"
        className="workflow-hidden-input"
        onChange={handleImportWorkflowJsonFile}
        ref={workflowImportInputRef}
        type="file"
      />

      {isWorkflowImportDialogOpen ? (
        <div className="workflow-import-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-import-title">
          <div className="workflow-import-modal__scrim" onClick={handleCloseWorkflowImportDialog} />
          <section className="workflow-import-modal__panel">
            <div className="panel-header">
              <div>
                <h2 id="workflow-import-title">Import workflow JSON</h2>
                <p>Choose whether to load a workflow from a file or paste canonical workflow JSON directly.</p>
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
                  <span>Open the file selector or drop a `.json` workflow file here.</span>
                </button>
                <button className="workflow-import-option" onClick={() => setWorkflowImportMode('paste')} type="button">
                  <strong>Paste workflow JSON</strong>
                  <span>Paste canonical workflow JSON into a text area and import it directly.</span>
                </button>
              </div>
            ) : (
              <div className="workflow-import-paste">
                <textarea
                  className="json-viewer"
                  onChange={(event) => setWorkflowImportPasteValue(event.target.value)}
                  placeholder="Paste workflow JSON here"
                  value={workflowImportPasteValue}
                />
                <div className="workflow-import-actions">
                  <button onClick={() => setWorkflowImportMode('choice')} type="button">
                    Back
                  </button>
                  <button disabled={workflowImportPasteValue.trim() === ''} onClick={() => void handleImportWorkflowPaste()} type="button">
                    Import pasted JSON
                  </button>
                </div>
              </div>
            )}

            <div className="workflow-import-actions">
              <button onClick={handleCloseWorkflowImportDialog} type="button">
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
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
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Validation</h2>
        <p>Editor issues and schema-aware workflow validation against the active table.</p>
      </div>
      {jsonError ? <pre className="json-error-panel">{jsonError}</pre> : null}
      {issues.length === 0 ? (
        <div className="empty-panel">No current workflow issues.</div>
      ) : (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li className="issue-item" key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong>
              <p>{issue.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkflowJsonPanel({ workflowJson }: { workflowJson: string }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Workflow JSON</h2>
        <p>Canonical IR generated from the current block workspace.</p>
      </div>
      <textarea className="json-viewer" readOnly value={workflowJson} />
    </section>
  );
}

function RunResultPanel({
  executionResult,
  onExportCsv,
  onExportXlsx,
}: {
  executionResult: WorkflowExecutionResult | null;
  onExportCsv: () => void;
  onExportXlsx: () => void;
}) {
  const canExport = Boolean(executionResult && executionResult.validationErrors.length === 0 && executionResult.transformedTable);

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Run result</h2>
          <p>Basic execution metadata from the existing deterministic executor.</p>
        </div>
        {canExport ? (
          <div className="export-actions">
            <button onClick={onExportCsv} type="button">
              Export CSV
            </button>
            <button onClick={onExportXlsx} type="button">
              Export XLSX
            </button>
          </div>
        ) : null}
      </div>
      {!executionResult ? (
        <div className="empty-panel">Run a valid workflow to see result metadata.</div>
      ) : executionResult.validationErrors.length > 0 ? (
        <div className="empty-panel">Run blocked by validation errors.</div>
      ) : (
        <dl className="result-stats">
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
                {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
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
                {table.schema.columns.map((column) => (
                  <td key={`${row.rowId}-${column.columnId}`}>{formatCellValue(row.cellsByColumnId[column.columnId])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
