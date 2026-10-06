// Private document storage: files live outside any static path and are served only
// through authorised, audited endpoints. Content is validated by magic bytes.
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId, STORAGE_DIR, tx } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { bad } from '../utils/errors.js';
import { assertDocumentAccess, assertEntityAccess, MEDICAL_CATEGORIES } from '../services/access.js';
import { audit } from '../services/audit.js';

const r = Router();
export const MAX_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
export const CATEGORIES = ['identity', 'income', 'medical_report', 'exam_report', 'bill', 'prescription', 'discharge_summary', 'death_certificate', 'claimant_id', 'entitlement_proof', 'bank_proof', 'other'];

function sniff(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

r.use(authenticate);

r.post('/', upload.single('file'), (req, res) => {
  const { entityType, entityId, category = 'other', description = '' } = req.body || {};
  if (!req.file) throw bad('A file is required');
  if (!CATEGORIES.includes(category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
  assertEntityAccess(req.user, entityType, entityId);
  const mime = sniff(req.file.buffer);
  if (!mime) throw bad('Invalid file content: only genuine PDF, PNG or JPEG files are accepted');
  const id = newId('doc');
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORAGE_DIR, `${id}.bin`), req.file.buffer);
  const doc = tx(() => {
    const d = db.insert('documents', {
      id, entityType, entityId, category, description, filename: path.basename(req.file.originalname).slice(0, 120),
      mime, size: req.file.size, uploadedBy: req.user.id, uploadedByName: req.user.name, uploadedByRole: req.user.role,
    });
    audit(req.user, 'DOCUMENT_UPLOADED', entityType, entityId, { documentId: id, category });
    return d;
  });
  res.status(201).json(doc);
});

r.get('/', (req, res) => {
  const { entityType, entityId } = req.query;
  assertEntityAccess(req.user, entityType, entityId);
  const docs = db.find('documents', (d) => d.entityType === entityType && d.entityId === entityId)
    .map((d) => ({ ...d, restricted: req.user.role === 'agent' && MEDICAL_CATEGORIES.includes(d.category) }));
  res.json(docs);
});

r.get('/:id/download', (req, res) => {
  const doc = assertDocumentAccess(req.user, db.get('documents', req.params.id));
  tx(() => audit(req.user, MEDICAL_CATEGORIES.includes(doc.category) ? 'MEDICAL_DOCUMENT_ACCESSED' : 'DOCUMENT_ACCESSED', doc.entityType, doc.entityId, { documentId: doc.id, category: doc.category }));
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(path.join(STORAGE_DIR, `${doc.id}.bin`)).pipe(res);
});

export default r;
