export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const bad = (msg, details) => new AppError(400, msg, details);
export const unprocessable = (msg, details) => new AppError(422, msg, details);
export const forbidden = (msg = 'You do not have permission to perform this action') => new AppError(403, msg);
export const notFound = (msg = 'Not found') => new AppError(404, msg);
export const conflict = (msg, details) => new AppError(409, msg, details);

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (maximum 5 MB)' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
