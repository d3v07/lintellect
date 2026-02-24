/**
 * CloudWatch Logs Insights query library for the Lintellect review pipeline.
 *
 * Export these strings to a CloudWatch dashboard or run them manually via
 * the AWS Console / CLI. Parameterise time ranges at query time.
 */

export const QUERIES = {
  /** Count successful vs failed jobs in the time range. */
  jobOutcomeSummary: `
fields @timestamp, status
| filter ispresent(jobId)
| stats count() as total,
        countif(status = 'completed') as succeeded,
        countif(status = 'failed')    as failed
  by bin(1h)
| sort @timestamp desc
`.trim(),

  /** P50 / P90 / P99 end-to-end duration in ms. */
  durationPercentiles: `
fields @timestamp, durationMs
| filter ispresent(durationMs)
| stats
    percentile(durationMs, 50) as p50_ms,
    percentile(durationMs, 90) as p90_ms,
    percentile(durationMs, 99) as p99_ms
  by bin(1h)
| sort @timestamp desc
`.trim(),

  /** Average AI token consumption per job. */
  tokenUsage: `
fields @timestamp, tokensUsed.total, tokensUsed.input, tokensUsed.output
| filter ispresent(tokensUsed.total)
| stats
    avg(tokensUsed.total)  as avg_total_tokens,
    avg(tokensUsed.input)  as avg_input_tokens,
    avg(tokensUsed.output) as avg_output_tokens
  by bin(1h)
`.trim(),

  /** Evidence gate pass rate — what fraction of AI comments survive validation. */
  evidencePassRate: `
fields @timestamp, evidenceMetrics.passRate
| filter ispresent(evidenceMetrics.passRate)
| stats avg(evidenceMetrics.passRate) * 100 as avg_pass_rate_pct
  by bin(1h)
| sort @timestamp desc
`.trim(),

  /** Top repositories by review volume. */
  topRepositories: `
fields repository
| filter ispresent(repository)
| stats count() as reviews by repository
| sort reviews desc
| limit 20
`.trim(),

  /** Recent failures with error messages. */
  recentFailures: `
fields @timestamp, jobId, repository, prNumber, error
| filter status = 'failed'
| sort @timestamp desc
| limit 50
`.trim(),

  /** Rate-limit rejections from the webhook lambda. */
  rateLimitHits: `
fields @timestamp, @message
| filter @message like /Monthly review limit reached/
| stats count() as limit_hits by bin(1h)
| sort @timestamp desc
`.trim(),
} as const;

export type QueryName = keyof typeof QUERIES;

/**
 * Returns the query string for the given name, ready to paste into
 * CloudWatch Logs Insights or pass to `aws logs start-query`.
 */
export function getQuery(name: QueryName): string {
  return QUERIES[name];
}
