import express from 'express';
import { loadSession, verifyCsrf } from '../accounts/session.js';
import { HttpError } from '../errors.js';
import { router as accountRouter } from './account.js';
import { router as adminRouter } from './admin.js';
import { router as authRouter } from './auth.js';
import { router as recoveryRouter } from './recovery.js';
import { panelLimiter } from './common.js';
import { errorPage, sendHtml } from './html.js';

/** The web panel: landing page, auth, user dashboard (/account) and admin panel (/admin). */
export const router = express.Router();

const PANEL_PATH = /^\/(?:$|login$|register$|logout$|forgot-password$|reset-password$|verify-email$|account(?:\/|$)|admin(?:\/|$))/;

router.use((req, res, next) => (PANEL_PATH.test(req.path) ? next() : next('router')));
router.use(
  panelLimiter,
  loadSession,
  express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 50 }),
  verifyCsrf,
);

router.use(authRouter);
router.use(recoveryRouter);
router.use('/account', accountRouter);
router.use('/admin', adminRouter);

router.use((req, res) => sendHtml(res, 404, errorPage(req, 404, 'আপনি যে পেজটি খুঁজছেন সেটি নেই।')));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  let status = 500;
  let message = 'অপ্রত্যাশিত একটি সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।';
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (err.type === 'entity.too.large') {
    [status, message] = [413, 'ফর্মের তথ্য অনেক বড়।'];
  } else if (err.type === 'entity.parse.failed' || err.type === 'parameters.too.many') {
    [status, message] = [400, 'ফর্মের তথ্য বোঝা যায়নি।'];
  }
  if (status >= 500) console.error(`[web] ${req.method} ${req.path}`, err);
  if (res.headersSent) return req.socket.destroy();
  sendHtml(res, status, errorPage(req, status, message));
});
