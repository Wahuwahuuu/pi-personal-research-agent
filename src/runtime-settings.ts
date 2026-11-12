/** The application supplies a bounded context projection for every Pi submission. */
export const managedRuntimeSettings = {
  // Historical transcripts are archival; workflowPrompt supplies the current bounded context.
  // Pi automatic summaries would spend the task budget on a second context mechanism.
  compaction: { enabled: false },
  retry: { maxRetries: 0 },
  stream: { timeoutMs: 90000 },
  progress: {
    partialIntervalMs: 1000,
    outputIntervalMs: 1000,
    persistWithinMs: 1000,
  },
};
