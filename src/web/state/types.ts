import type { Category, Incident } from '../../shared/contracts.js';

export type HistoryRange = '7d' | '30d' | '90d' | 'month';
export type FaultSeverity = Exclude<Incident['severity'], null | 'maintenance'>;
export interface ViewState {
  view: 'grid' | 'incidents' | 'day';
  date: string;
  category: Category | '';
  query: string;
  onlyAbnormal: boolean;
  provider: string;
  range: HistoryRange;
  month: string;
  severity: FaultSeverity[];
  providers: string[];
}
export interface HistoryFilters {
  /** Bind lazy history to the summary currently displayed by the caller. */
  snapshotId?: string;
  range: HistoryRange;
  month?: string;
  severity?: FaultSeverity[];
  providers?: string[];
}
