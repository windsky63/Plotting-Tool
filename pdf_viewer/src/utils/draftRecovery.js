const IDENTITY_MARKER = '%LUOTU_DRAFT_IDENTITY_V1:';

export const getDraftDocumentId = fileInfo => fileInfo?.documentId ||
  `pdf_${fileInfo?.originalFingerprint || fileInfo?.fingerprint || ''}`;

export function validateRecoveryDraft(draft) {
  if (!draft || !Array.isArray(draft.annotations)) return { valid: false, reason: '标注数据无法读取' };
  if (draft.annotations.some(a => !a || typeof a !== 'object')) return {valid: false, reason: '草稿包含无效标注'};
  if (draft.annotationPages !== undefined && !Array.isArray(draft.annotationPages)) return {valid: false, reason: '草稿页码索引无效'};
  if (draft.fileInfo?.name !== undefined && typeof draft.fileInfo.name !== 'string') return {valid: false, reason: '草稿文件身份无效'};
  if (draft.annotationCount !== undefined && Number(draft.annotationCount) !== draft.annotations.length) {
    return { valid: false, reason: `标注不完整：应有 ${draft.annotationCount} 条，实际 ${draft.annotations.length} 条` };
  }
  const pages = new Set(draft.annotations.map(a => Number(a?.page || 1)));
  const missing = (draft.annotationPages || []).filter(page => !pages.has(Number(page)));
  if (missing.length) return { valid: false, reason: `草稿缺少第 ${missing.join('、')} 页数据` };
  if (draft.annotations.some(a => !Number.isInteger(Number(a?.page || 1)) || Number(a?.page || 1) < 1 ||
      (Number(draft.totalPages) > 0 && Number(a?.page || 1) > Number(draft.totalPages)))) {
    return { valid: false, reason: '草稿页码与图纸不一致' };
  }
  return { valid: true, reason: '' };
}

export function matchRecoveryFile(draftFileInfo, selectedFileInfo) {
  if (!draftFileInfo || !selectedFileInfo) return false;
  if (draftFileInfo.projectId && selectedFileInfo.projectId && draftFileInfo.projectId !== selectedFileInfo.projectId) return false;
  const left = draftFileInfo.originalFingerprint || draftFileInfo.fingerprint;
  const right = selectedFileInfo.originalFingerprint || selectedFileInfo.fingerprint;
  const sameQueryKey = Boolean(draftFileInfo.fingerprint && draftFileInfo.fingerprint === selectedFileInfo.fingerprint);
  const sameLineage = sameQueryKey || getDraftDocumentId(draftFileInfo) === getDraftDocumentId(selectedFileInfo);
  if (sameLineage && (left || draftFileInfo.documentId)) {
    return !(draftFileInfo.pageCount && selectedFileInfo.pageCount &&
      Number(draftFileInfo.pageCount) !== Number(selectedFileInfo.pageCount));
  }
  return Boolean(left && right && left === right);
}

export async function readPdfDraftIdentity(file) {
  if (!file?.slice) return null;
  const tail = new TextDecoder().decode(await file.slice(Math.max(0, file.size - 16384)).arrayBuffer());
  const offset = tail.lastIndexOf(IDENTITY_MARKER);
  if (offset < 0) return null;
  try {
    const encoded = tail.slice(offset + IDENTITY_MARKER.length).split(/[\r\n]/)[0].trim();
    const identity = JSON.parse(decodeURIComponent(atob(encoded)));
    return /^[a-zA-Z0-9_.-]{1,128}$/.test(identity.documentId || '') &&
      /^[a-zA-Z0-9_.-]{1,128}$/.test(identity.originalFingerprint || '') &&
      (!identity.recoveryUserKey || /^[a-zA-Z0-9_.-]{1,80}$/.test(identity.recoveryUserKey)) &&
      Number.isInteger(identity.pageCount) && identity.pageCount > 0 ? identity : null;
  } catch { return null; }
}

export function appendPdfDraftIdentity(output, fileInfo, userKey, pageCount) {
  if (!fileInfo?.fingerprint) return output;
  const identity = {
    documentId: getDraftDocumentId(fileInfo),
    originalFingerprint: fileInfo.originalFingerprint || fileInfo.fingerprint,
    sourceName: fileInfo.sourceName || fileInfo.name,
    sourceSize: fileInfo.sourceSize || fileInfo.size,
    recoveryUserKey: fileInfo.recoveryUserKey || userKey,
    pageCount,
  };
  const encoded = btoa(encodeURIComponent(JSON.stringify(identity)));
  const footer = new TextEncoder().encode(`\n${IDENTITY_MARKER}${encoded}\n`);
  // A PDF trailing comment is readable without loading the PDF object graph.
  if (output instanceof Blob) return new Blob([output, footer], {type: 'application/pdf'});
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  const result = new Uint8Array(bytes.length + footer.length);
  result.set(bytes); result.set(footer, bytes.length);
  return result;
}

export const draftTime = draft => {
  const time = Date.parse(draft?.updatedAt || draft?.savedAt || draft?.serverSavedAt || draft?.timestamp || '');
  return Number.isFinite(time) ? time : 0;
};
