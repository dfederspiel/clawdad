import {
  getDelegationRun,
  insertDelegationRun,
  listDelegationRunsForGroup,
  updateDelegationRun,
} from '../db.js';
import { DelegationRun } from './types.js';

export class DelegationStore {
  create(run: DelegationRun): void {
    insertDelegationRun(run);
  }

  get(id: string): DelegationRun | undefined {
    return getDelegationRun(id);
  }

  listForGroup(groupJid: string, limit?: number): DelegationRun[] {
    return listDelegationRunsForGroup(groupJid, limit);
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        DelegationRun,
        'status' | 'startedAt' | 'completedAt' | 'result' | 'error'
      >
    >,
  ): DelegationRun | undefined {
    updateDelegationRun(id, patch);
    return this.get(id);
  }
}
