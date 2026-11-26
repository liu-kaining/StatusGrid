import { useEffect, useState } from 'react';
import type { Incident } from '../../shared/contracts.js';
import { dataClient, SnapshotChangedError } from './client.js';

export function useDayHistory(snapshotId: string, enabled = true, refreshSnapshot?: () => Promise<void>) {
  const [result, setResult] = useState<{ snapshotId: string; incidents: Incident[] | null; error: Error | null }>({ snapshotId: '', incidents: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !snapshotId) return;
    const controller = new AbortController();
    setResult({ snapshotId, incidents: null, error: null });
    dataClient.loadDayHistory(snapshotId, controller.signal).then((incidents) => {
      if (!controller.signal.aborted) setResult({ snapshotId, incidents, error: null });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setResult({ snapshotId, incidents: null, error: reason instanceof Error ? reason : new Error('事件加载失败') });
      if (reason instanceof SnapshotChangedError) void refreshSnapshot?.();
    });
    return () => controller.abort();
  }, [snapshotId, enabled, attempt, refreshSnapshot]);
  return { ...(result.snapshotId === snapshotId ? result : { incidents: null, error: null }), retry: () => setAttempt((value) => value + 1) };
}
