# Legacy migration implementation plan

1. Extend shared options/form with explicit migration source and compatibility answer.
2. Add private source inspection, SDK-compatible writer exclusion, opaque copy, deployment rebinding and durable publication receipt.
3. Integrate migration phases with existing server orchestration, retaining exact runtime selection across retries.
4. Verify all migrated identities without bootstrap, retire the source service and provide prepared client configuration.
5. Add failure/retry and filesystem regression fixtures; update usage and README.
6. Push to PR8, run GitHub CI only, resolve failures, obtain independent review, report exact validated head and supported boundaries.
