// Project/App: gsd-pi
// File Purpose: Stand-in workflow-executors module that echoes the basePath a
// registered GSD tool resolved, so base-path routing can be asserted through a
// real tool invocation instead of a direct helper call.

interface RecordedResult {
  content: Array<{ type: "text"; text: string }>;
  details: { operation: string; basePath: string };
}

function recordBasePath(operation: string) {
  return async (_params: unknown, basePath: string): Promise<RecordedResult> => ({
    content: [{ type: "text", text: `${operation} recorded` }],
    details: { operation, basePath },
  });
}

// importWorkflowExecutorsModule accepts a module as executors when it exports
// executeSummarySave and executeSkipSlice; the rest are the tools under test.
export const executeSummarySave = recordBasePath("summary_save");
export const executeSkipSlice = recordBasePath("skip_slice");
export const executeTaskComplete = recordBasePath("task_complete");
