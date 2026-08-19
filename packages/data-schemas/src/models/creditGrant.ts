import { Model } from 'mongoose';
import type * as t from '~/types';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import creditGrantSchema from '~/schema/creditGrant';

export function createCreditGrantModel(mongoose: typeof import('mongoose')): Model<t.ICreditGrant> {
  applyTenantIsolation(creditGrantSchema);
  return mongoose.models.CreditGrant || mongoose.model<t.ICreditGrant>('CreditGrant', creditGrantSchema);
}
