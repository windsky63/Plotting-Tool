import {TextDecoder} from 'util';
const encode = text => Uint8Array.from([...text].map(c => c.charCodeAt(0)));
import {PDFDocument, PDFName, PDFString, PDFDict, PDFArray, decodePDFRawStream} from 'pdf-lib';
import * as lib from 'pdf-lib';
import {replacePdfAnnotationAttachment} from './replacePdfAnnotationAttachment';

test('re-export replaces nested annotation entry while preserving other attachments and name trees', async () => {
  let doc = await PDFDocument.create(); doc.addPage();
  await doc.attach(new Uint8Array([1, 2, 3]), 'other.bin'); await doc.flush();
  const n = PDFName.of;
  const names = doc.catalog.lookup(n('Names'), PDFDict);
  names.set(n('Dests'), doc.context.obj({Names: [PDFString.of('bookmark'), doc.context.obj([])]}));
  replacePdfAnnotationAttachment(doc, encode('{"annotations":[1]}'), lib);
  // Exercise an indirect Kids tree, as produced by other PDF applications.
  const first = names.get(n('EmbeddedFiles'));
  names.set(n('EmbeddedFiles'), doc.context.register(doc.context.obj({Kids: [first]})));
  doc = await PDFDocument.load(await doc.save());
  replacePdfAnnotationAttachment(doc, encode('{"annotations":[2,3]}'), lib);
  doc = await PDFDocument.load(await doc.save());
  const outputNames = doc.catalog.lookup(n('Names'), PDFDict);
  expect(outputNames.has(n('Dests'))).toBe(true);
  const entries = outputNames.lookup(n('EmbeddedFiles'), PDFDict).lookup(n('Names'), PDFArray);
  expect(entries.size()).toBe(4);
  expect(entries.get(0).decodeText()).toBe('annotations.json');
  const spec = entries.lookup(1, PDFDict);
  const data = spec.lookup(n('EF'), PDFDict).lookup(n('F'));
  expect(new TextDecoder().decode(decodePDFRawStream(data).decode())).toBe('{"annotations":[2,3]}');
  expect(entries.get(2).decodeText()).toBe('other.bin');
});
