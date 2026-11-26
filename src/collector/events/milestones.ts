import { STATUS_SEVERITY } from '../../shared/status.js';
import type { Incident } from '../../shared/contracts.js';
import type { Milestone, NotificationLedger } from '../types.js';
import { isActiveFault, isClosed } from './normalize.js';

export function recordMilestones(
  ledger: NotificationLedger, previous: Incident | undefined, incident: Incident, now: string, current: boolean,
): void {
  if (incident.supersededBy || incident.kind === 'advisory') return;
  const identity = ledger.aliases[incident.id] ?? incident.id;
  const add = (kind: Milestone['kind'], suffix: string) => {
    const id = `${identity}:${suffix}`;
    if (!ledger.milestones.some((milestone) => milestone.id === id)) {
      ledger.milestones.push({ id, incidentId: identity, kind, at: now });
    }
  };
  if (isActiveFault(incident) && current) {
    add('triggered', 'triggered');
    if (previous?.severity && incident.severity
      && STATUS_SEVERITY[incident.severity] > STATUS_SEVERITY[previous.severity]) {
      const updateId = incident.updates.at(-1)?.id ?? `${incident.id}:update:${incident.updatedAt}`;
      add('escalated', `escalated:${updateId}`);
    }
  }
  if (previous && !isClosed(previous) && isClosed(incident)
    && ledger.milestones.some((milestone) => milestone.id === `${identity}:triggered`)) {
    add('resolved', 'resolved');
  }
}
