import { useEffect, useState } from 'react';
import type { Incident } from '../../shared/contracts.js';
import { dataClient } from './client.js';

export function useDayHistory(snapshotId: string, enabled = true) {
  const [result, setResult] = useState<{ snapshotId: string; incidents: Incident[] | null; error: string }>({ snapshotId: '', incidents: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !snapshotId) return;
    const controller = new AbortController();
    setResult({ snapshotId, incidents: null, error: '' });
    dataClient.loadDayHistory(snapshotId, controller.signal).then((incidents) => {
      if (!controller.signal.aborted) setResult({ snapshotId, incidents, error: '' });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setResult({ snapshotId, incidents: null, error: reason instanceof Error ? reason.message : '事件加载失败' });
    });
    return () => controller.abort();
  }, [snapshotId, enabled, attempt]);
  return { ...(result.snapshotId === snapshotId ? result : { incidents: null, error: '' }), retry: () => setAttempt((value) => value + 1) };
}
