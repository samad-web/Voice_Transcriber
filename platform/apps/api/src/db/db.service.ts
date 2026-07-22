import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { closeAllPools, getAdminPool, withOrgContext } from "@aura/db";

@Injectable()
export class DbService implements OnModuleDestroy {
  /** Tenant-scoped transaction — RLS enforced via app.org_id. */
  readonly withOrg = withOrgContext;

  /**
   * RLS-bypassing pool. Only for flows that run before an org context exists
   * (enrollment token lookup, bootstrap). Everything else uses withOrg.
   */
  readonly adminPool = getAdminPool;

  async onModuleDestroy(): Promise<void> {
    await closeAllPools();
  }
}
