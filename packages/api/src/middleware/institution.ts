import mongoose from 'mongoose';
import { InstitutionStatuses, type IInstitution, logger } from '@librechat/data-schemas';
import type { Model } from 'mongoose';

export type InstitutionValidationResult =
  | {
      ok: true;
      institution?: Pick<IInstitution, 'tenantId' | 'status' | 'name'>;
      degraded?: 'registry_unavailable' | 'not_found';
    }
  | {
      ok: false;
      reason: 'registry_unavailable' | 'not_found' | 'inactive';
      statusCode: 403 | 404 | 503;
      message: string;
    };

/**
 * Whether an unregistered tenant should be refused outright.
 *
 * Off by default. The institution registry gates *suspension*, which is an
 * explicit administrative act; a tenant with no registry row at all is an
 * unmigrated or newly provisioned one, and refusing it would lock every legacy
 * user out of every route. The same leniency covers the startup window before
 * the models are registered. Turn this on once every tenant is migrated.
 */
function institutionGateIsStrict(): boolean {
  return (
    String(process.env.TENANT_REQUIRE_REGISTERED_INSTITUTION ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

function getInstitutionModel(): Model<IInstitution> | undefined {
  return mongoose.models.Institution as Model<IInstitution> | undefined;
}

export async function validateActiveInstitution(
  tenantId: string,
): Promise<InstitutionValidationResult> {
  const Institution = getInstitutionModel();
  if (!Institution) {
    logger.error('[validateActiveInstitution] Institution model is not registered');
    if (institutionGateIsStrict()) {
      return {
        ok: false,
        reason: 'registry_unavailable',
        statusCode: 503,
        message: 'Institution registry is unavailable',
      };
    }
    return { ok: true, degraded: 'registry_unavailable' };
  }

  const institution = await Institution.findOne({ tenantId })
    .select('tenantId status name')
    .lean<Pick<IInstitution, 'tenantId' | 'status' | 'name'> | null>()
    .exec();

  if (!institution) {
    if (institutionGateIsStrict()) {
      return {
        ok: false,
        reason: 'not_found',
        statusCode: 404,
        message: 'Institution not found',
      };
    }
    logger.warn('[validateActiveInstitution] tenant has no institution record; allowing request', {
      tenantId,
    });
    return { ok: true, degraded: 'not_found' };
  }

  if (institution.status !== InstitutionStatuses.ACTIVE) {
    return {
      ok: false,
      reason: 'inactive',
      statusCode: 403,
      message: 'Institution is not active',
    };
  }

  return { ok: true, institution };
}
