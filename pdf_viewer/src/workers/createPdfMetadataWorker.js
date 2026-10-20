export const createPdfMetadataWorker = () => new Worker(new URL('./pdfMetadata.worker.js', import.meta.url));
