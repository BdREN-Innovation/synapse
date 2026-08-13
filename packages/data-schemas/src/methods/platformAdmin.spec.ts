import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PlatformRoles } from '~/common';
import type { IPlatformAdmin } from '~/types';
import platformAdminSchema from '~/schema/platformAdmin';
import { createPlatformAdminMethods } from './platformAdmin';

let mongoServer: MongoMemoryServer;
let PlatformAdmin: mongoose.Model<IPlatformAdmin>;
let methods: ReturnType<typeof createPlatformAdminMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  PlatformAdmin =
    mongoose.models.PlatformAdmin ||
    mongoose.model<IPlatformAdmin>('PlatformAdmin', platformAdminSchema);
  methods = createPlatformAdminMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await PlatformAdmin.deleteMany({});
});

describe('platformAdmin methods', () => {
  it('upserts a new platform superadmin without conflicting update paths', async () => {
    const userId = new Types.ObjectId();

    const admin = await methods.upsertPlatformAdmin({
      userId,
      email: 'SuperAdmin@Example.com',
      role: PlatformRoles.SUPERADMIN,
      active: true,
    });

    expect(admin).toEqual(
      expect.objectContaining({
        email: 'superadmin@example.com',
        role: PlatformRoles.SUPERADMIN,
        active: true,
      }),
    );
    expect(admin.userId?.toString()).toBe(userId.toString());
    await expect(PlatformAdmin.countDocuments({ email: 'superadmin@example.com' })).resolves.toBe(1);
  });

  it('updates the existing registry entry instead of creating a duplicate', async () => {
    const firstUserId = new Types.ObjectId();
    const secondUserId = new Types.ObjectId();

    await methods.upsertPlatformAdmin({
      userId: firstUserId,
      email: 'superadmin@example.com',
    });
    const updated = await methods.upsertPlatformAdmin({
      userId: secondUserId,
      email: 'superadmin@example.com',
      active: true,
    });

    expect(updated.userId?.toString()).toBe(secondUserId.toString());
    await expect(PlatformAdmin.countDocuments({ email: 'superadmin@example.com' })).resolves.toBe(1);
  });
});
