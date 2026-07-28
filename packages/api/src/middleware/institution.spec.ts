import mongoose from 'mongoose';
import { validateActiveInstitution } from './institution';

jest.mock('@librechat/data-schemas', () => ({
  InstitutionStatuses: { ACTIVE: 'active', SUSPENDED: 'suspended' },
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function registerInstitutionModel(record: unknown) {
  (mongoose.models as Record<string, unknown>).Institution = {
    findOne: () => ({
      select: () => ({
        lean: () => ({
          exec: async () => record,
        }),
      }),
    }),
  };
}

describe('validateActiveInstitution', () => {
  const originalStrict = process.env.TENANT_REQUIRE_REGISTERED_INSTITUTION;

  afterEach(() => {
    delete (mongoose.models as Record<string, unknown>).Institution;
    if (originalStrict === undefined) {
      delete process.env.TENANT_REQUIRE_REGISTERED_INSTITUTION;
    } else {
      process.env.TENANT_REQUIRE_REGISTERED_INSTITUTION = originalStrict;
    }
  });

  it('admits a tenant whose institution is active', async () => {
    registerInstitutionModel({ tenantId: 'inst-a', status: 'active', name: 'Inst A' });
    await expect(validateActiveInstitution('inst-a')).resolves.toMatchObject({ ok: true });
  });

  it('always refuses a suspended institution', async () => {
    registerInstitutionModel({ tenantId: 'inst-a', status: 'suspended', name: 'Inst A' });
    await expect(validateActiveInstitution('inst-a')).resolves.toMatchObject({
      ok: false,
      reason: 'inactive',
      statusCode: 403,
    });
  });

  it('admits an unregistered tenant rather than locking it out of every route', async () => {
    registerInstitutionModel(null);
    await expect(validateActiveInstitution('legacy-tenant')).resolves.toMatchObject({
      ok: true,
      degraded: 'not_found',
    });
  });

  it('admits requests that arrive before the models are registered', async () => {
    await expect(validateActiveInstitution('inst-a')).resolves.toMatchObject({
      ok: true,
      degraded: 'registry_unavailable',
    });
  });

  it('refuses an unregistered tenant when the strict gate is enabled', async () => {
    process.env.TENANT_REQUIRE_REGISTERED_INSTITUTION = 'true';
    registerInstitutionModel(null);
    await expect(validateActiveInstitution('legacy-tenant')).resolves.toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });
});
