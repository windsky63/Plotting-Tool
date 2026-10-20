import {readPdfEditableAnnotations} from './pdfAnnotationAttachments';

// Return only editable data, never the parsed PDF object graph or source bytes.
export async function parsePdfMetadataPayload(bytes, pdfLib) {
  const options = {updateMetadata: false};
  if (pdfLib.ParseSpeeds?.Fastest) options.parseSpeed = pdfLib.ParseSpeeds.Fastest;
  const doc = await pdfLib.PDFDocument.load(bytes, options);
  let keywordString = '';
  try {
    const keywords = doc.getKeywords();
    keywordString = Array.isArray(keywords) ? keywords.join(' ') : (keywords || '');
  } catch { /* A malformed optional field must not block attachment recovery. */ }
  let hasImageAnnotations = false;
  for (const page of doc.getPages().slice(0, 3)) {
    const resources = page.node.Resources;
    if (resources?.XObject && Object.keys(resources.XObject).length > 1) hasImageAnnotations = true;
  }
  try {
    const annotationData = await readPdfEditableAnnotations(doc, pdfLib);
    return {annotationData, keywordString, hasImageAnnotations,
      loadMethod: /ANNOTATION_DATA:[^:]+:[^:]+:ATTACHMENT/.test(keywordString) ? 'attachment' : 'keywords'};
  } catch (error) {
    return {annotationData: null, keywordString, hasImageAnnotations, error: error.message};
  }
}
