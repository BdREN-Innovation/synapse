import type { FilterQuery, Model } from 'mongoose';
import type { IInstitution } from '~/types';
import { InstitutionStatuses } from '~/common';

/**
 * Fields that must never be changed through the generic update path.
 * Lifecycle state (`status`, suspension metadata) has dedicated methods;
 * `stats` is a derived counter; `createdBy`/`tenantId`/timestamps are
 * provenance. This is a defense-in-depth backstop behind the route-level
 * allowlist (P1-2).
 */
const PROTECTED_INSTITUTION_FIELDS = [
  'tenantId',
  'status',
  'stats',
  'createdBy',
  'suspendedAt',
  'suspendedBy',
  'createdAt',
  'updatedAt',
] as const;

export interface InstitutionMethods {
  listInstitutions: (options?: {
    filter?: FilterQuery<IInstitution>;
    limit?: number;
    offset?: number;
  }) => Promise<IInstitution[]>;
  countInstitutions: (filter?: FilterQuery<IInstitution>) => Promise<number>;
  getInstitutionByTenantId: (
    tenantId: string,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<IInstitution | null>;
  createInstitution: (data: Partial<IInstitution>) => Promise<IInstitution>;
  deleteInstitutionByTenantId: (tenantId: string) => Promise<boolean>;
  updateInstitutionByTenantId: (
    tenantId: string,
    updates: Partial<IInstitution>,
  ) => Promise<IInstitution | null>;
  suspendInstitution: (
    tenantId: string,
    options?: { suspendedBy?: string },
  ) => Promise<IInstitution | null>;
  reactivateInstitution: (tenantId: string) => Promise<IInstitution | null>;
  closeInstitution: (tenantId: string) => Promise<IInstitution | null>;
}

export function createInstitutionMethods(mongoose: typeof import('mongoose')): InstitutionMethods {
  const getModel = () => mongoose.models.Institution as Model<IInstitution>;

  async function listInstitutions(options?: {
    filter?: FilterQuery<IInstitution>;
    limit?: number;
    offset?: number;
  }): Promise<IInstitution[]> {
    const Institution = getModel();
    const query = Institution.find(options?.filter ?? {}).sort({ createdAt: -1 });
    if (options?.offset != null) {
      query.skip(options.offset);
    }
    if (options?.limit != null && options.limit > 0) {
      query.limit(options.limit);
    }
    return await query.lean<IInstitution[]>().exec();
  }

  async function countInstitutions(filter: FilterQuery<IInstitution> = {}): Promise<number> {
    return await getModel().countDocuments(filter);
  }

  async function getInstitutionByTenantId(
    tenantId: string,
    fieldsToSelect: string | string[] | null = null,
  ): Promise<IInstitution | null> {
    const query = getModel().findOne({ tenantId: tenantId.trim() });
    if (fieldsToSelect) {
      query.select(fieldsToSelect);
    }
    return await query.lean<IInstitution | null>().exec();
  }

  async function createInstitution(data: Partial<IInstitution>): Promise<IInstitution> {
    return await getModel().create({
      status: InstitutionStatuses.ACTIVE,
      authDomains: [],
      ...data,
      tenantId: data.tenantId?.trim(),
      slug: data.slug?.trim(),
      name: data.name?.trim(),
    });
  }

  /**
   * Removes an institution row outright. Intended for compensating a failed
   * provisioning attempt, where the row was written but no administrator could
   * be appointed; the unique `tenantId` would otherwise make every retry
   * collide with a half-created institution.
   */
  async function deleteInstitutionByTenantId(tenantId: string): Promise<boolean> {
    const result = await getModel().deleteOne({ tenantId: tenantId?.trim() }).exec();
    return (result?.deletedCount ?? 0) > 0;
  }

  async function updateInstitutionByTenantId(
    tenantId: string,
    updates: Partial<IInstitution>,
  ): Promise<IInstitution | null> {
    const safeUpdates = { ...updates };
    for (const field of PROTECTED_INSTITUTION_FIELDS) {
      delete (safeUpdates as Record<string, unknown>)[field];
    }
    return await getModel()
      .findOneAndUpdate(
        { tenantId: tenantId.trim() },
        {
          $set: {
            ...safeUpdates,
            ...(typeof safeUpdates.name === 'string' ? { name: safeUpdates.name.trim() } : null),
            ...(typeof safeUpdates.slug === 'string' ? { slug: safeUpdates.slug.trim() } : null),
          },
        },
        { new: true },
      )
      .lean<IInstitution | null>()
      .exec();
  }

  async function suspendInstitution(
    tenantId: string,
    options?: { suspendedBy?: string },
  ): Promise<IInstitution | null> {
    return await getModel()
      .findOneAndUpdate(
        { tenantId: tenantId.trim() },
        {
          $set: {
            status: InstitutionStatuses.SUSPENDED,
            suspendedAt: new Date(),
            ...(options?.suspendedBy ? { suspendedBy: options.suspendedBy } : null),
          },
        },
        { new: true },
      )
      .lean<IInstitution | null>()
      .exec();
  }

  async function reactivateInstitution(tenantId: string): Promise<IInstitution | null> {
    return await getModel()
      .findOneAndUpdate(
        { tenantId: tenantId.trim() },
        {
          $set: {
            status: InstitutionStatuses.ACTIVE,
            suspendedAt: null,
            suspendedBy: null,
          },
        },
        { new: true },
      )
      .lean<IInstitution | null>()
      .exec();
  }

  async function closeInstitution(tenantId: string): Promise<IInstitution | null> {
    return await getModel()
      .findOneAndUpdate(
        { tenantId: tenantId.trim(), status: { $ne: InstitutionStatuses.CLOSED } },
        { $set: { status: InstitutionStatuses.CLOSED } },
        { new: true },
      )
      .lean<IInstitution | null>()
      .exec();
  }

  return {
    listInstitutions,
    countInstitutions,
    getInstitutionByTenantId,
    createInstitution,
    deleteInstitutionByTenantId,
    updateInstitutionByTenantId,
    suspendInstitution,
    reactivateInstitution,
    closeInstitution,
  };
}
