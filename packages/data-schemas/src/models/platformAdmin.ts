import { Model } from 'mongoose';
import type { IPlatformAdmin } from '~/types';
import platformAdminSchema from '~/schema/platformAdmin';

/**
 * PlatformAdmin is a platform control-plane registry. It intentionally does
 * not use tenant isolation because authorization must be evaluated before any
 * cross-tenant platform action begins.
 */
export function createPlatformAdminModel(
  mongoose: typeof import('mongoose'),
): Model<IPlatformAdmin> {
  return (
    mongoose.models.PlatformAdmin ||
    mongoose.model<IPlatformAdmin>('PlatformAdmin', platformAdminSchema)
  );
}
