import nodemailer from 'nodemailer';
import { config } from '../config.js';

/** Messages "sent" with MAIL_TRANSPORT=log or memory, newest last (used by tests and local development). */
export const outbox = [];

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  const { transport, host, port, secure, requireTls, user, password } = config.mail;
  if (transport === 'smtp') {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure && requireTls,
      auth: user ? { user, pass: password } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  } else {
    transporter = {
      async sendMail(message) {
        outbox.push(message);
        if (outbox.length > 200) outbox.shift();
        if (transport === 'log') {
          console.log(`\n[mail] To: ${message.to}\n[mail] Subject: ${message.subject}\n${message.text}\n`);
        }
        return { messageId: `local-${Date.now()}` };
      },
    };
  }
  return transporter;
}

/** Header values must never contain line breaks (header injection). */
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

export async function sendMail({ to, subject, html, text }) {
  return getTransporter().sendMail({
    from: config.mail.from || `${oneLine(config.appName)} <no-reply@localhost>`,
    ...(config.mail.replyTo ? { replyTo: config.mail.replyTo } : {}),
    to: oneLine(to),
    subject: oneLine(subject),
    html,
    text,
  });
}

/**
 * Sends without making the caller wait. Used where response time must not reveal whether an
 * email was sent (e.g. "forgot password" for unknown addresses), and for non-critical notices.
 */
export function sendMailInBackground(message) {
  sendMail(message).catch((err) => console.error(`[mail] failed to send "${oneLine(message.subject)}": ${err.message}`));
}

/** Verifies SMTP credentials at startup so misconfiguration shows up immediately. */
export async function verifyMailer() {
  if (config.mail.transport !== 'smtp') return null;
  await getTransporter().verify();
  return `${config.mail.host}:${config.mail.port}`;
}
