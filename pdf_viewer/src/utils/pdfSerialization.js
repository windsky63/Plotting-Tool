// Keep pdf-lib's byte format and use elapsed-time-bounded work slices.
// Annotated downloads may target Blob chunks instead of a whole-file buffer.
// The pdf-lib document remains on the caller thread, while the completed byte
// chunks can be transferred to a one-shot Worker for Blob assembly. This keeps
// output byte-identical and lets the browser discard the assembler heap as one
// unit immediately after the download Blob is returned.
const SAVE_OPTIONS = { useObjectStreams: false, updateFieldAppearances: false };

export async function savePdfWithTimeBudget(pdfDoc, {
  pdfLib = typeof window !== 'undefined' ? window.PDFLib : null,
  onProgress,
  timeBudgetMs = 12,
  now = () => performance.now(),
  output = 'bytes',
  chunkSizeBytes = 4 * 1024 * 1024,
} = {}) {
  const startedAt = now();
  const Writer = pdfLib?.PDFWriter;
  if (!Writer?.forContext || !pdfDoc.context?.enumerateIndirectObjects || !pdfDoc.flush) {
    const bytes = await pdfDoc.save(SAVE_OPTIONS);
    return { bytes, diagnostics: { mode: 'compatible-save', durationMs: Math.round(now() - startedAt) } };
  }

  // Match PDFDocument.save({ addDefaultPage: true, updateFieldAppearances: false }).
  if (pdfDoc.getPageCount() === 0) pdfDoc.addPage();
  onProgress?.({ stage: 'flushing', completedSteps: 0, totalSteps: 0 });
  await pdfDoc.flush();
  const flushedAt = now();
  const objectCount = pdfDoc.context.enumerateIndirectObjects().length;
  // PDFWriter traverses objects twice: sizing/xref and copying unchanged bytes.
  const totalSteps = objectCount * 2;
  const writer = Writer.forContext(pdfDoc.context, Infinity);
  if (typeof writer.shouldWaitForTick !== 'function' || typeof writer.serializeToBuffer !== 'function') {
    const bytes = await pdfDoc.save(SAVE_OPTIONS);
    return { bytes, diagnostics: { mode: 'compatible-save', durationMs: Math.round(now() - startedAt) } };
  }

  const budget = Math.max(4, Math.min(16, Number(timeBudgetMs) || 12));
  let sliceStart = now();
  let yieldedAt = null;
  let lastReportAt = -Infinity;
  let completedSteps = 0;
  let yieldCount = 0;
  let waitMs = 0;
  let maxSliceMs = 0;
  const report = (currentTime, force = false) => {
    if (force || currentTime - lastReportAt >= 100) {
      lastReportAt = currentTime;
      onProgress?.({
        stage: completedSteps <= objectCount ? 'sizing' : 'writing',
        completedSteps: Math.min(totalSteps, completedSteps),
        totalSteps,
      });
    }
  };

  writer.shouldWaitForTick = () => {
    const currentTime = now();
    completedSteps += 1;
    // A delayed timer must NOT immediately cause another wait after one object.
    // Start a fresh budget when the original writer resumes after its await.
    if (yieldedAt !== null) {
      waitMs += currentTime - yieldedAt;
      yieldedAt = null;
      sliceStart = currentTime;
    }
    report(currentTime);
    const sliceMs = currentTime - sliceStart;
    if (sliceMs < budget || completedSteps >= totalSteps) return false;
    maxSliceMs = Math.max(maxSliceMs, sliceMs);
    yieldCount += 1;
    yieldedAt = currentTime;
    return true;
  };

  // If writing fails (including allocation/OOM), propagate it. Retrying with a
  // second writer would increase memory pressure and hide the actual failure.
  const result = output === 'blob'
    ? await serializePdfToBlob(writer, { chunkSizeBytes })
    : { bytes: await writer.serializeToBuffer() };
  const finishedAt = now();
  maxSliceMs = Math.max(maxSliceMs, finishedAt - sliceStart);
  completedSteps = totalSteps;
  report(finishedAt, true);
  return {
    ...result,
    diagnostics: {
      mode: output === 'blob' ? 'chunked-blob-writer' : 'time-budget-writer',
      objectCount,
      outputBytes: result.blob?.size ?? result.bytes.length,
      maxBufferBytes: result.maxBufferBytes,
      blobAssemblyMode: result.blobAssemblyMode,
      flushMs: Math.round(flushedAt - startedAt),
      durationMs: Math.round(finishedAt - startedAt),
      yieldCount,
      waitMs: Math.round(waitMs),
      maxSliceMs: Math.round(maxSliceMs),
      timeBudgetMs: budget,
    },
  };
}

// Preserve PDFWriter's header, object bytes, xref offsets and trailer exactly.
// Only the destination changes: bounded buffers -> immutable Blob parts, never
// a Uint8Array the size of the entire annotated PDF. No flattening arrayBuffer().
async function serializePdfToBlob(writer, { chunkSizeBytes }) {
  const { size, header, indirectObjects, xref, trailerDict, trailer } = await writer.computeBufferSize();
  const chunkLimit = Math.max(1024, Math.min(8 * 1024 * 1024, Number(chunkSizeBytes) || 4 * 1024 * 1024));
  const isolatedAssembler = await createIsolatedBlobAssembler();
  const parts = isolatedAssembler ? null : [];
  let buffer = null;
  let offset = 0;
  let writtenBytes = 0;
  let maxBufferBytes = 0;
  const flush = () => {
    if (!offset) return;
    const completedLength = offset;
    if (isolatedAssembler) {
      isolatedAssembler.append(buffer, completedLength);
    } else {
      parts.push(new Blob([buffer.subarray(0, completedLength)]));
    }
    writtenBytes += completedLength;
    buffer = null;
    offset = 0;
  };
  const reserve = length => {
    if (buffer && buffer.length - offset >= length) return;
    flush();
    // A single PDF object is copied atomically using pdf-lib's own serializer.
    // Usually these are small compressed image/content streams.
    const allocation = Math.max(length, Math.min(chunkLimit, size - writtenBytes));
    buffer = new Uint8Array(allocation);
    maxBufferBytes = Math.max(maxBufferBytes, allocation);
  };
  const text = value => {
    for (let i = 0; i < value.length; i += 1) buffer[offset++] = value.charCodeAt(i);
  };
  const append = (object, suffix = '') => {
    reserve(object.sizeInBytes() + suffix.length);
    offset += object.copyBytesInto(buffer, offset);
    text(suffix);
  };
  try {
    append(header, '\n\n');
    for (const [ref, object] of indirectObjects) {
      const prefix = `${ref.objectNumber} ${ref.generationNumber} obj\n`;
      reserve(prefix.length + object.sizeInBytes() + 9);
      text(prefix);
      offset += object.copyBytesInto(buffer, offset);
      text('\nendobj\n\n');
      if (writer.shouldWaitForTick(1)) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (xref) append(xref, '\n');
    if (trailerDict) append(trailerDict, '\n\n');
    append(trailer);
    flush();
    if (writtenBytes !== size) throw new Error('PDF 分块封装长度校验失败');
    const blob = isolatedAssembler
      ? await isolatedAssembler.finish()
      : new Blob(parts, { type: 'application/pdf' });
    return {
      blob,
      maxBufferBytes,
      blobAssemblyMode: isolatedAssembler ? 'isolated-worker' : 'main-thread'
    };
  } finally {
    buffer = null;
    if (parts) parts.length = 0;
    isolatedAssembler?.dispose();
  }
}

async function createIsolatedBlobAssembler() {
  if (
    typeof Worker === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof Blob === 'undefined'
  ) {
    return null;
  }

  const workerSource = `
    const chunks = [];
    self.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'chunk') {
        chunks.push(data.buffer);
        return;
      }
      if (data.type === 'finish') {
        try {
          const blob = new Blob(chunks, { type: 'application/pdf' });
          chunks.length = 0;
          self.postMessage({ type: 'done', blob });
        } catch (error) {
          self.postMessage({ type: 'error', message: error?.message || String(error) });
        }
      }
    };
    self.postMessage({ type: 'ready' });
  `;
  let workerUrl = '';
  let worker = null;
  try {
    workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    worker = new Worker(workerUrl);
  } catch (error) {
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    return null;
  }

  let readyResolve;
  let readyReject;
  let finishResolve;
  let finishReject;
  let finished = false;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const finishPromise = new Promise((resolve, reject) => {
    finishResolve = resolve;
    finishReject = reject;
  });
  // A rejected finish promise must be observed even when Worker startup falls
  // back to the main thread before finish() is called.
  finishPromise.catch(() => {});
  worker.onmessage = event => {
    const data = event.data || {};
    if (data.type === 'ready') readyResolve();
    else if (data.type === 'done') {
      finished = true;
      finishResolve(data.blob);
    } else if (data.type === 'error') {
      const error = new Error(data.message || 'PDF Worker封装失败');
      readyReject(error);
      finishReject(error);
    }
  };
  worker.onerror = event => {
    const error = new Error(event?.message || 'PDF Worker启动失败');
    readyReject(error);
    finishReject(error);
  };

  let startupTimer = null;
  try {
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error('PDF Worker启动超时')), 2000);
      })
    ]);
  } catch (error) {
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    return null;
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
  }

  return {
    append(chunk, length) {
      if (finished) throw new Error('PDF Worker已结束');
      const exactChunk = length === chunk.byteLength ? chunk : chunk.slice(0, length);
      worker.postMessage({ type: 'chunk', buffer: exactChunk.buffer }, [exactChunk.buffer]);
    },
    finish() {
      worker.postMessage({ type: 'finish' });
      return finishPromise;
    },
    dispose() {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  };
}
