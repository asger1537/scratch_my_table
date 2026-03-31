import type { Table } from '../domain/model';

import type { ValidationWorkerResponse, ValidationWorkerTableSnapshot } from './validationWorker';
import type { Workflow, WorkflowValidationIssue } from './types';

export function createValidationWorkerTableSnapshot(table: Table): ValidationWorkerTableSnapshot {
  return {
    tableId: table.tableId,
    sourceName: table.sourceName,
    schema: {
      columns: table.schema.columns.map((column) => ({ ...column })),
    },
  };
}

export function validateWorkflowWithWorker(
  workflow: Workflow,
  tableSnapshot: ValidationWorkerTableSnapshot,
  signal?: AbortSignal,
): Promise<WorkflowValidationIssue[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const requestId = 1;
    const worker = new Worker(new URL('./validation.worker.ts', import.meta.url), { type: 'module' });

    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
      if (event.data.requestId !== requestId) {
        return;
      }

      cleanup();
      resolve(event.data.issues);
    };

    worker.onerror = () => {
      cleanup();
      reject(new Error('Workflow validation worker failed.'));
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    worker.postMessage({
      requestId,
      workflow,
      table: tableSnapshot,
    });
  });
}

function createAbortError() {
  return new DOMException('The operation was aborted.', 'AbortError');
}
