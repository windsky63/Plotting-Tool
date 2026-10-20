import {TextEncoder, TextDecoder} from 'util';
import {PDFDocument, PDFName, PDFString} from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import {appendPdfDraftIdentity, readPdfDraftIdentity, matchRecoveryFile, validateRecoveryDraft} from './draftRecovery';
import {readPdfAnnotationAttachment, readPdfEditableAnnotations} from './pdfAnnotationAttachments';

global.TextEncoder = TextEncoder; global.TextDecoder = TextDecoder;
test('an exported and renamed PDF retains source identity with a lightweight footer read', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = appendPdfDraftIdentity(await pdf.save(), {name: '原图.pdf', size: 100, fingerprint: 'source'}, 'web_owner', 1);
  const file = {size: bytes.length, slice: start => ({arrayBuffer: async () => bytes.slice(start).buffer})};
  const identity = await readPdfDraftIdentity(file);
  expect(identity).toMatchObject({documentId: 'pdf_source', originalFingerprint: 'source', recoveryUserKey: 'web_owner'});
  expect(matchRecoveryFile({name: '原图.pdf', size: 100, fingerprint: 'source'}, {...identity, name: '另存.pdf', size: bytes.length, fingerprint: 'exported'})).toBe(true);
  expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
});
test('different source files, projects and page counts cannot silently match', () => {
  expect(matchRecoveryFile({fingerprint: 'a'}, {fingerprint: 'b'})).toBe(false);
  expect(matchRecoveryFile({fingerprint: 'a', projectId: 'x'}, {fingerprint: 'a', projectId: 'y'})).toBe(false);
  expect(matchRecoveryFile({fingerprint: 'a', pageCount: 1}, {fingerprint: 'a', pageCount: 2})).toBe(false);
});
test('missing shards and wrong annotation counts are rejected, including an empty partial draft', () => {
  expect(validateRecoveryDraft({annotationCount: 2, annotations: [{page: 1}]}).valid).toBe(false);
  expect(validateRecoveryDraft({annotationCount: 2, annotations: []}).valid).toBe(false);
  expect(validateRecoveryDraft({annotationPages: [1, 2], annotations: [{page: 1}]}).valid).toBe(false);
  expect(validateRecoveryDraft({totalPages: 1, annotations: [{page: 2}]}).valid).toBe(false);
  expect(validateRecoveryDraft({annotationCount: 0, annotationPages: [], annotations: []}).valid).toBe(true);
  expect(validateRecoveryDraft({annotationPages: {}, annotations: []}).valid).toBe(false);
});
const attachment = (pdf, annotations) => {
  const stream = pdf.context.register(pdf.context.flateStream(JSON.stringify({annotations})));
  return pdf.context.register(pdf.context.obj({Type: PDFName.of('Filespec'), F: PDFString.of('annotations.json'), EF: {F: stream}}));
};
test('the reachable attachment replaces an earlier orphan, including indirect Kids name trees', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  attachment(pdf, [{id: 'old', page: 1}]);
  const current = attachment(pdf, [{id: 'new', page: 1}]);
  const child = pdf.context.register(pdf.context.obj({Names: [PDFString.of('annotations.json'), current]}));
  const tree = pdf.context.register(pdf.context.obj({Kids: [child]}));
  pdf.catalog.set(PDFName.of('Names'), pdf.context.register(pdf.context.obj({EmbeddedFiles: tree})));
  const reopened = await PDFDocument.load(await pdf.save());
  expect((await readPdfAnnotationAttachment(reopened, pdfLib)).annotations).toEqual([{id: 'new', page: 1}]);
});
test('a valid directory without annotations never falls back to an orphan attachment', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); attachment(pdf, [{id: 'orphan'}]);
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({EmbeddedFiles: {Names: []}}));
  expect(await readPdfAnnotationAttachment(pdf, pdfLib)).toBeNull();
});
test('current inline metadata takes precedence over an old reachable attachment left by an earlier export', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const old = attachment(pdf, [{id: 'old', page: 1}]);
  pdf.catalog.set(PDFName.of('Names'), pdf.context.obj({EmbeddedFiles: {Names: [PDFString.of('annotations.json'), old]}}));
  pdf.setKeywords([`ANNOTATION_DATA:PDF标注查看器:1.0:${JSON.stringify({annotations: [{id: 'new', page: 1}]})}`]);
  expect((await readPdfEditableAnnotations(pdf, pdfLib)).annotations).toEqual([{id: 'new', page: 1}]);
});
