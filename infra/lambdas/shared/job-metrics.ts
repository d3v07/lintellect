/**
 * CloudWatch custom metrics emitter for the Lintellect review pipeline.
 *
 * Publishes structured metric data to CloudWatch using the EMF (Embedded
 * Metric Format) log protocol — zero additional API calls needed,
 * CloudWatch Logs automatically parses the JSON and creates metrics.
 *
 * Usage: call emitJobMetrics() at the end of any Lambda handler.
 */

export interface JobMetricPayload {
  jobId:          string;
  durationMs:     number;
  totalTokens:    number;
  inputTokens:    number;
  outputTokens:   number;
  commentCount:   number;
  acceptedCount:  number;
  rejectedCount:  number;
  passRate:       number;   // 0–1
  status:         'completed' | 'failed';
  repository?:    string;
}

/**
 * Write an EMF-formatted JSON line to stdout.
 * CloudWatch Logs Agent picks this up and publishes the metrics
 * to the `LintellectPipeline` namespace.
 */
export function emitJobMetrics(payload: JobMetricPayload): void {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'LintellectPipeline',
          Dimensions: [['Status'], ['Repository']],
          Metrics: [
            { Name: 'DurationMs',    Unit: 'Milliseconds' },
            { Name: 'TotalTokens',   Unit: 'Count' },
            { Name: 'CommentCount',  Unit: 'Count' },
            { Name: 'AcceptedCount', Unit: 'Count' },
            { Name: 'PassRate',      Unit: 'None' },
          ],
        },
      ],
    },
    // Dimensions
    Status:     payload.status,
    Repository: payload.repository ?? 'unknown',
    // Metric values
    DurationMs:    payload.durationMs,
    TotalTokens:   payload.totalTokens,
    CommentCount:  payload.commentCount,
    AcceptedCount: payload.acceptedCount,
    PassRate:      payload.passRate,
    // Non-metric context fields
    jobId:          payload.jobId,
    inputTokens:    payload.inputTokens,
    outputTokens:   payload.outputTokens,
    rejectedCount:  payload.rejectedCount,
  };

  // Single synchronous write — no async overhead in the hot path
  process.stdout.write(JSON.stringify(emf) + '\n');
}
