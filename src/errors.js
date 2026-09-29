export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
