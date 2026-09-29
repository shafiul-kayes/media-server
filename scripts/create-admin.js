// Creates an admin account and emails an invitation to set the password, or promotes an
// existing user to admin.
//   npm run create-admin -- --email admin@example.com --name "Admin"
//   npm run create-admin -- --email someone@example.com --promote
// The invitation link is also printed here when email is not configured (MAIL_TRANSPORT=log)
// or could not be sent, so the first admin can always get in.
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string', default: 'Administrator' },
    promote: { type: 'boolean', default: false },
  },
});

const { config } = await import('../src/config.js');
const { closeDb } = await import('../src/db.js');
const { migrate } = await import('../src/schema.js');
const { users } = await import('../src/accounts/repo.js');
const { hashPassword } = await import('../src/accounts/password.js');
const { sendInvitation } = await import('../src/accounts/tokens.js');
const { normalizeEmail, validateName } = await import('../src/accounts/validate.js');

try {
  await migrate();
  const email = normalizeEmail(values.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide a valid --email');

  const existing = await users.findByEmail(email);
  if (values.promote) {
    if (!existing) throw new Error(`No user with email ${email}`);
    await users.setRole(existing.id, 'admin');
    await users.setStatus(existing.id, 'active');
    console.log(`${email} is now an admin.${existing.email_verified_at ? '' : ' They must verify their email before opening the admin panel.'}`);
  } else {
    if (existing) throw new Error(`${email} already exists. Use --promote to make that user an admin.`);
    const errors = {};
    const name = validateName(values.name, errors);
    if (errors.name) throw new Error('Name must be 2-100 characters');

    // The account gets a random password nobody knows; the admin sets their own via the emailed link,
    // which also proves they own the address.
    const id = await users.create({ name, email, role: 'admin', passwordHash: await hashPassword(crypto.randomBytes(32).toString('base64url')) });
    const { sent, token } = await sendInvitation({ id, name, email }, { role: 'admin', invitedBy: 'System', ip: null });
    const link = `${config.baseUrl}/reset-password?token=${token}`;

    console.log(`Admin account created for ${email}.`);
    if (sent && config.mail.transport === 'smtp') {
      console.log('An invitation email with a link to set the password has been sent.');
    } else {
      console.log(sent ? '\nEmail is not configured (MAIL_TRANSPORT=log). Open this link to set the password:' : '\nThe invitation email could not be sent. Open this link to set the password:');
      console.log(`\n  ${link}\n`);
      console.log(`The link works once and expires in ${config.accounts.inviteTokenDays} days.`);
    }
  }
} catch (err) {
  console.error(err.code ? `${err.code}: ${err.message}` : err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
