import { config } from '../config.js';
import { esc } from '../pages/html.js';

/**
 * Transactional emails in Bengali. Each returns { subject, html, text }. Email clients ignore
 * stylesheets, so the HTML uses inline styles and a simple table layout. All user-supplied
 * values go through `esc`.
 */

function layout({ heading, paragraphs, button, footnote }) {
  const html = `<!doctype html>
<html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Hind Siliguri','Noto Sans Bengali',Arial,sans-serif;color:#16191f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e1e4ea;border-radius:10px">
    <tr><td style="padding:20px 28px;border-bottom:1px solid #e1e4ea;font-weight:700;font-size:18px;color:#2458e6">${esc(config.appName)}</td></tr>
    <tr><td style="padding:28px">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4">${esc(heading)}</h1>
      ${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7">${p}</p>`).join('\n      ')}
      ${button ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#2458e6;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">${esc(button.label)}</a></p>
      <p style="margin:0 0 14px;font-size:13px;color:#5d6573;line-height:1.6">বাটন কাজ না করলে এই লিংকটি ব্রাউজারে পেস্ট করুন:<br><a href="${esc(button.url)}" style="color:#2458e6;word-break:break-all">${esc(button.url)}</a></p>` : ''}
      ${footnote ? `<p style="margin:20px 0 0;font-size:13px;color:#5d6573;line-height:1.6">${footnote}</p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 28px;border-top:1px solid #e1e4ea;font-size:12px;color:#5d6573">এই ইমেইলটি ${esc(config.appName)} থেকে স্বয়ংক্রিয়ভাবে পাঠানো হয়েছে। অনুগ্রহ করে এর উত্তর দেবেন না।</td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const strip = (s) => s.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const text = [
    heading,
    '',
    ...paragraphs.map(strip).flatMap((p) => [p, '']),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(footnote ? [strip(footnote), ''] : []),
    `— ${config.appName}`,
  ].join('\n');

  return { html, text };
}

const hi = (name) => `আসসালামু আলাইকুম ${esc(name)},`;
const bn = (n) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[d]);
const url = (path) => `${config.baseUrl}${path}`;

export function verifyEmail({ name, token }) {
  return {
    subject: `আপনার ইমেইল যাচাই করুন — ${config.appName}`,
    ...layout({
      heading: 'ইমেইল ঠিকানা যাচাই করুন',
      paragraphs: [
        hi(name),
        `${esc(config.appName)} এ অ্যাকাউন্ট খোলার জন্য ধন্যবাদ। API অ্যাক্সেসের অনুরোধ করার আগে নিচের বাটনে ক্লিক করে নিশ্চিত করুন যে এই ইমেইল ঠিকানাটি আপনার।`,
      ],
      button: { label: 'ইমেইল যাচাই করুন', url: url(`/verify-email?token=${token}`) },
      footnote: `লিংকটি ${bn(config.accounts.verifyTokenHours)} ঘণ্টা কাজ করবে। আপনি অ্যাকাউন্ট না খুলে থাকলে এই ইমেইল উপেক্ষা করুন।`,
    }),
  };
}

export function resetPassword({ name, token }) {
  return {
    subject: `পাসওয়ার্ড রিসেট — ${config.appName}`,
    ...layout({
      heading: 'পাসওয়ার্ড রিসেট করুন',
      paragraphs: [hi(name), 'আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেট করার অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড সেট করতে নিচের বাটনে ক্লিক করুন।'],
      button: { label: 'নতুন পাসওয়ার্ড সেট করুন', url: url(`/reset-password?token=${token}`) },
      footnote: `লিংকটি ${bn(config.accounts.resetTokenMinutes)} মিনিট কাজ করবে এবং একবারই ব্যবহার করা যাবে। আপনি অনুরোধ না করে থাকলে এই ইমেইল উপেক্ষা করুন; আপনার পাসওয়ার্ড বদলাবে না।`,
    }),
  };
}

export function invitation({ name, role, invitedBy, token }) {
  const roleLabel = role === 'admin' ? 'অ্যাডমিন' : 'ইউজার';
  return {
    subject: `${config.appName} এ আপনাকে আমন্ত্রণ`,
    ...layout({
      heading: `${config.appName} এ আমন্ত্রণ`,
      paragraphs: [
        hi(name),
        `${esc(invitedBy)} আপনাকে ${esc(config.appName)} এ <strong>${roleLabel}</strong> হিসেবে যুক্ত করেছেন। অ্যাকাউন্ট চালু করতে নিচের বাটনে ক্লিক করে নিজের পাসওয়ার্ড সেট করুন।`,
      ],
      button: { label: 'পাসওয়ার্ড সেট করে শুরু করুন', url: url(`/reset-password?token=${token}`) },
      footnote: `আমন্ত্রণটি ${bn(config.accounts.inviteTokenDays)} দিন কাজ করবে। আপনি এটি আশা না করে থাকলে এই ইমেইল উপেক্ষা করুন।`,
    }),
  };
}

export function passwordChanged({ name }) {
  return {
    subject: `আপনার পাসওয়ার্ড বদলানো হয়েছে — ${config.appName}`,
    ...layout({
      heading: 'পাসওয়ার্ড বদলানো হয়েছে',
      paragraphs: [
        hi(name),
        `আপনার ${esc(config.appName)} অ্যাকাউন্টের পাসওয়ার্ড এইমাত্র বদলানো হয়েছে, আর নিরাপত্তার জন্য সব ডিভাইস থেকে লগআউট করা হয়েছে।`,
        '<strong>আপনি এটি না করে থাকলে</strong> এখনই পাসওয়ার্ড রিসেট করুন এবং অ্যাডমিনকে জানান।',
      ],
      button: { label: 'পাসওয়ার্ড রিসেট করুন', url: url('/forgot-password') },
    }),
  };
}

export function appApproved({ name, appName, appId, note }) {
  return {
    subject: `API অনুরোধ অনুমোদিত: ${appName}`,
    ...layout({
      heading: 'আপনার API অনুরোধ অনুমোদিত হয়েছে 🎉',
      paragraphs: [
        hi(name),
        `<strong>${esc(appName)}</strong> অ্যাপের জন্য API অ্যাক্সেস অনুমোদন করা হয়েছে। ড্যাশবোর্ড থেকে এখন আপনার API key তৈরি করতে পারবেন।`,
        ...(note ? [`অ্যাডমিনের মন্তব্য: ${esc(note)}`] : []),
      ],
      button: { label: 'API key তৈরি করুন', url: url(`/account/apps/${appId}`) },
      footnote: 'key তৈরির পর ইন্টিগ্রেশন গাইডে আপনার অ্যাপের জন্য সাজানো কোড পাবেন।',
    }),
  };
}

export function appRejected({ name, appName, appId, note }) {
  return {
    subject: `API অনুরোধের সিদ্ধান্ত: ${appName}`,
    ...layout({
      heading: 'আপনার API অনুরোধ অনুমোদিত হয়নি',
      paragraphs: [
        hi(name),
        `দুঃখিত, <strong>${esc(appName)}</strong> অ্যাপের অনুরোধটি এবার অনুমোদন করা যায়নি।`,
        `কারণ: ${esc(note)}`,
        'প্রয়োজনীয় তথ্য সংশোধন করে আবার অনুরোধ করতে পারেন।',
      ],
      button: { label: 'বিস্তারিত দেখুন', url: url(`/account/apps/${appId}`) },
    }),
  };
}

export function appRevoked({ name, appName, appId, note }) {
  return {
    subject: `API অ্যাক্সেস বাতিল: ${appName}`,
    ...layout({
      heading: 'API অ্যাক্সেস বাতিল করা হয়েছে',
      paragraphs: [
        hi(name),
        `<strong>${esc(appName)}</strong> অ্যাপের API key আর কাজ করবে না। আপলোড করা ফাইল আপাতত থেকে যাবে।`,
        ...(note ? [`কারণ: ${esc(note)}`] : []),
        'বিষয়টি নিয়ে প্রশ্ন থাকলে অ্যাডমিনের সাথে যোগাযোগ করুন।',
      ],
      button: { label: 'অ্যাপের অবস্থা দেখুন', url: url(`/account/apps/${appId}`) },
    }),
  };
}

export function newRequestForAdmins({ adminName, userName, userEmail, appName, appId }) {
  return {
    subject: `নতুন API অনুরোধ: ${appName}`,
    ...layout({
      heading: 'নতুন API অনুরোধ রিভিউয়ের অপেক্ষায়',
      paragraphs: [
        hi(adminName),
        `${esc(userName)} (${esc(userEmail)}) <strong>${esc(appName)}</strong> অ্যাপের জন্য API অ্যাক্সেস চেয়েছেন।`,
      ],
      button: { label: 'অনুরোধ রিভিউ করুন', url: url(`/admin/requests/${appId}`) },
    }),
  };
}
