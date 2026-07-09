/**
 * Bootstrap / promote a super_admin. Run:
 *   node scripts/create-admin.mjs <email> [name] [password]
 *
 * If the user exists they're promoted to admin/super_admin with all permissions.
 * If not, a new admin account is created (password required in that case).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const [, , email, name, password] = process.argv;
if (!email) {
  console.error('Usage: node scripts/create-admin.mjs <email> [name] [password]');
  process.exit(1);
}

const db = new PrismaClient();
const perms = { userManagement: true, payouts: true, disputes: true, overrides: true };

try {
  let user = await db.user.findUnique({ where: { email: email.toLowerCase() } });

  if (!user) {
    if (!password) {
      console.error('New admin — a password is required: node scripts/create-admin.mjs <email> <name> <password>');
      process.exit(1);
    }
    user = await db.user.create({
      data: {
        name: name ?? 'Admin',
        email: email.toLowerCase(),
        emailVerified: true,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'admin',
        adminSubRole: 'super_admin',
      },
    });
    console.log(`Created admin ${user.email}`);
  } else {
    await db.user.update({ where: { id: user.id }, data: { role: 'admin', adminSubRole: 'super_admin' } });
    console.log(`Promoted ${user.email} to super_admin`);
  }

  await db.adminPermission.upsert({ where: { userId: user.id }, update: perms, create: { userId: user.id, ...perms } });
  console.log('Permissions granted:', perms);
} finally {
  await db.$disconnect();
}
