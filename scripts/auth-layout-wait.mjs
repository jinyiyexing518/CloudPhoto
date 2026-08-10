const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForCondition(
  check,
  {
    attempts = 2,
    attemptTimeoutMs = 15_000,
    now = Date.now,
    onRetry = async () => {},
    pollIntervalMs = 100,
    sleep = delay,
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const deadline = now() + attemptTimeoutMs;
    do {
      if (await check()) return true;
      await sleep(pollIntervalMs);
    } while (now() < deadline);

    if (attempt + 1 < attempts) await onRetry();
  }
  return false;
}
