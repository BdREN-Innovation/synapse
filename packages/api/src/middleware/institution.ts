import mongoose from 'mongoose';
import {
  InstitutionStatuses,
  type IInstitution,
  logger,
} from '@librechat/data-schemas';
import type { Model } from 'mongoose';

export type InstitutionValidationResult =
  | { ok: true; institution: Pick<IInstitution, 'tenantId' | 'status' | 'name'> }
  | {
      ok: false;
      reason: 'registry_unavailable' | 'not_found' | 'inactive';
      statusCode: 403 | 404 | 503;
      message: string;
    };

function getInstitutionModel(): Model<IInstitution> | undefined {
  return mongoose.models.Institution as Model<IInstitution> | undefined;
}

export async function validateActiveInstitution(
  tenantId: string,
): Promise<InstitutionValidationResult> {
  const Institution = getInstitutionModel();
  if (!Institution) {
    logger.error('[validateActiveInstitution] Institution model is not registered');
    return {
      ok: false,
      reason: 'registry_unavailable',
      statusCode: 503,
      message: 'Institution registry is unavailable',
    };
  }

  const institution = await Institution.findOne({ tenantId })
    .select('tenantId status name')
    .lean<Pick<IInstitution, 'tenantId' | 'status' | 'name'> | null>()
    .exec();

  if (!institution) {
    return {
      ok: false,
      reason: 'not_found',
      statusCode: 404,
      message: 'Institution not found',
    };
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
