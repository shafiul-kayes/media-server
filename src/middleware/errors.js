import multer from 'multer';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

const MULTER_ERRORS = {
  LIMIT_FILE_SIZE: [413, 'file_too_large', `File exceeds the ${Math.round(config.maxFileSize / 1048576)} MB limit`],
  LIMIT_FILE_COUNT: [400, 'too_many_files', 'Only one file per request is allowed'],
  LIMIT_UNEXPECTED_FILE: [400, 'unexpected_field', 'Send the file in a multipart field named "file"'],
  LIMIT_PART_COUNT: [400, 'too_many_parts', 'Too many form parts'],
  LIMIT_FIELD_COUNT: [400, 'too_many_fields', 'Too many form fields'],
  LIMIT_FIELD_KEY: [400, 'field_name_too_long', 'Form field name too long'],
  LIMIT_FIELD_VALUE: [400, 'field_value_too_long', 'Form field value too long'],
};

export function notFoundHandler(req, res) {
  res.status(404).json({ success: false, error: { code: 'not_found', message: 'Not found' } });
}

// Express recognises error handlers by their 4-argument signature.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'internal_error';
  let message = 'Internal server error';

  if (err instanceof HttpError) {
    ({ status, code, message } = err);
  } else if (err instanceof multer.MulterError) {
    [status, code, message] = MULTER_ERRORS[err.code] ?? [400, 'invalid_upload', 'Invalid upload'];
  } else if (err.type === 'entity.parse.failed') {
    [status, code, message] = [400, 'invalid_json', 'Malformed JSON body'];
  } else if (err.type === 'entity.too.large') {
    [status, code, message] = [413, 'body_too_large', 'Request body too large'];
  } else if (err.message === 'Unexpected end of form' || err.message === 'Multipart: Boundary not found') {
    [status, code, message] = [400, 'invalid_upload', 'Malformed multipart body'];
  }

  // Internals are logged server-side only; clients never see stack traces or paths.
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}`, err);
  if (res.headersSent) return req.socket.destroy();
  res.status(status).json({ success: false, error: { code, message } });
}

export function requestLogger(req, res, next) {
  if (config.env === 'test') return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    // Only the path is logged: query strings may contain signatures.
    console.log(`${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
