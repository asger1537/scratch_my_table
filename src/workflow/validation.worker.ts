import { validateWorkflowAgainstSchemaSnapshot, type ValidationWorkerRequest, type ValidationWorkerResponse } from './validationWorker';

self.onmessage = (event: MessageEvent<ValidationWorkerRequest>) => {
  const issues = validateWorkflowAgainstSchemaSnapshot(event.data.workflow, event.data.table);
  const response: ValidationWorkerResponse = {
    requestId: event.data.requestId,
    issues,
  };

  self.postMessage(response);
};
