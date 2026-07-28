import type { FilterQuery, Model, Types } from 'mongoose';
import { PlatformRoles } from '~/common';
import type { IPlatformAdmin } from '~/types';

export interface PlatformAdminMethods {
  listPlatformAdmins: (filter?: FilterQuery<IPlatformAdmin>) => Promise<IPlatformAdmin[]>;
  getPlatformAdminForUser: (params: {
    userId?: string | Types.ObjectId;
    email?: string;
  }) => Promise<IPlatformAdmin | null>;
  upsertPlatformAdmin: (data: {
    userId?: string | Types.ObjectId;
    email: string;
    role?: string;
    active?: boolean;
    grantedBy?: string | Types.ObjectId;
  }) => Promise<IPlatformAdmin>;
  deactivatePlatformAdmin: (params: {
    userId?: string | Types.ObjectId;
    email?: string;
  }) => Promise<IPlatformAdmin | null>;
  seedPlatformSuperadmins: (emails: string[]) => Promise<void>;
}

export function createPlatformAdminMethods(
  mongoose: typeof import('mongoose'),
): PlatformAdminMethods {
  const getModel = () => mongoose.models.PlatformAdmin as Model<IPlatformAdmin>;

  async function listPlatformAdmins(
    filter: FilterQuery<IPlatformAdmin> = {},
  ): Promise<IPlatformAdmin[]> {
    return await getModel().find(filter).sort({ createdAt: -1 }).lean<IPlatformAdmin[]>().exec();
  }

  async function getPlatformAdminForUser(params: {
    userId?: string | Types.ObjectId;
    email?: string;
  }): Promise<IPlatformAdmin | null> {
    const or: FilterQuery<IPlatformAdmin>[] = [];
    if (params.userId != null) {
      or.push({ userId: params.userId });
    }
    if (params.email) {
      or.push({ email: params.email.trim().toLowerCase() });
    }
    if (or.length === 0) {
      return null;
    }
    return await getModel().findOne({ $or: or }).lean<IPlatformAdmin | null>().exec();
  }

  async function upsertPlatformAdmin(data: {
    userId?: string | Types.ObjectId;
    email: string;
    role?: string;
    active?: boolean;
    grantedBy?: string | Types.ObjectId;
  }): Promise<IPlatformAdmin> {
    const email = data.email.trim().toLowerCase();
    const doc = await getModel()
      .findOneAndUpdate(
        { email },
        {
          $set: {
            email,
            role: data.role ?? PlatformRoles.SUPERADMIN,
            active: data.active ?? true,
            revokedAt: data.active === false ? new Date() : null,
            ...(data.userId != null ? { userId: data.userId } : null),
            ...(data.grantedBy != null ? { grantedBy: data.grantedBy } : null),
          },
        },
        { upsert: true, new: true },
      )
      .lean<IPlatformAdmin | null>()
      .exec();

    return doc as IPlatformAdmin;
  }

  async function deactivatePlatformAdmin(params: {
    userId?: string | Types.ObjectId;
    email?: string;
  }): Promise<IPlatformAdmin | null> {
    const or: FilterQuery<IPlatformAdmin>[] = [];
    if (params.userId != null) {
      or.push({ userId: params.userId });
    }
    if (params.email) {
      or.push({ email: params.email.trim().toLowerCase() });
    }
    if (or.length === 0) {
      return null;
    }
    return await getModel()
      .findOneAndUpdate(
        { $or: or },
        { $set: { active: false, revokedAt: new Date() } },
        { new: true },
      )
      .lean<IPlatformAdmin | null>()
      .exec();
  }

  async function seedPlatformSuperadmins(emails: string[]): Promise<void> {
    const uniqueEmails = [
      ...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
    ];
    if (uniqueEmails.length === 0) {
      return;
    }

    await Promise.all(
      uniqueEmails.map((email) =>
        upsertPlatformAdmin({
          email,
          role: PlatformRoles.SUPERADMIN,
          active: true,
        }),
      ),
    );
  }

  return {
    listPlatformAdmins,
    getPlatformAdminForUser,
    upsertPlatformAdmin,
    deactivatePlatformAdmin,
    seedPlatformSuperadmins,
  };
}
