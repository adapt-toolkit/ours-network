try {
  const response = await fetch('http://127.0.0.1:8420/api/healthz', {
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  process.exitCode = response.ok ? 0 : 1;
} catch { process.exitCode = 1; }
