import { confirmPipelineLabels, WeldAiService, LEADER_CONFIRM_PATH } from './weldAiService';

test('explicit sample confirmation promotes only inferred OCR pipelines', () => {
  expect(confirmPipelineLabels([
    { pipelineNumber: 'P-1', pipelineNumberSource: 'inferred' },
    { pipelineNumber: 'P-2', pipelineNumberSource: 'business_data' },
    { weldNumber: '1' }
  ])).toEqual([
    { pipelineNumber: 'P-1', pipelineNumberSource: 'ocr_confirmed' },
    { pipelineNumber: 'P-2', pipelineNumberSource: 'business_data' },
    { weldNumber: '1' }
  ]);
});

test('legacy visible joint text survives label building, normalization, JSON POST and receipt validation', async () => {
  const service = new WeldAiService();
  jest.spyOn(service, 'getHealth').mockResolvedValue({ reachable: true });
  jest.spyOn(service, 'renderPageRegion').mockResolvedValue({
    pageWidth: 600, pageHeight: 800, imageWidth: 1200, imageHeight: 1600,
    renderScale: 2, imageDataUrl: 'data:image/png;base64,test',
  });
  jest.spyOn(service, 'queueConfirmedSample').mockResolvedValue(null);
  jest.spyOn(service, 'updateQueuedSample').mockResolvedValue(null);
  jest.spyOn(service, 'getQueuedSample').mockResolvedValue(null);
  const counts = { labelCount: 2, numberedLabelCount: 2, jointTypeLabelCount: 2, completeLabelCount: 2 };
  jest.spyOn(service, 'request').mockResolvedValue({ status: 202, data: { receiptId: 'test-receipt', status: 'queued', ...counts } });
  jest.spyOn(service, 'waitUntilSampleStored').mockResolvedValue({ status: 'stored', ...counts });
  const annotations = ['1"BW', '6"RR'].map((topText, i) => ({
    id: `joint-${i}`, page: 1, text: `F${i + 1}X`, topText,
    pipelineNumber: i ? '002-P/B-01' : '001-P/A-01',
    pipelineNumberSource: i ? 'business_data' : 'user_confirmed',
    borderShape: 'split-circle', hasLeaderLine: true,
    startX: 100 + i * 50, startY: 100, endX: 200 + i * 50, endY: 200,
  }));
  const result = await service.submitConfirmedAnnotations({
    pdfDocument: {}, pdfFile: new File(['test'], 'test.pdf'), annotations, projectName: 'test',
  });
  expect(service.request).toHaveBeenCalledTimes(1);
  const [url, options] = service.request.mock.calls[0];
  expect(url).toBe(LEADER_CONFIRM_PATH);
  const payload = JSON.parse(options.body);
  expect(payload.labels.map(label => [label.weldNumber, label.jointType])).toEqual([['F1X', 'BW'], ['F2X', 'RR']]);
  expect(payload.labels.map(label => [label.pipelineNumber, label.pipelineNumberSource])).toEqual([
    ['001-P/A-01', 'user_confirmed'], ['002-P/B-01', 'business_data']
  ]);
  expect(payload.pipelineNumberSchemaVersion).toBe(1);
  expect(payload.recognitionArea).toEqual({});
  expect(payload.labels[0].leaderPipeEnd).toEqual({ xNorm: 50 / 600, yNorm: 50 / 800 });
  expect(result).toMatchObject({ uploaded: 1, jointTypeLabels: 2, completeLabels: 2 });
  jest.restoreAllMocks();
});

test('queue migration removes only unaccepted payloads built before pipeline schema', async () => {
  const service = new WeldAiService();
  const validLabel = { leaderPipeEnd: { xNorm: 0.1, yNorm: 0.2 } };
  jest.spyOn(service, 'getQueuedSamples').mockResolvedValue([
    { id: 'old-pending', state: 'pending_local', payload: { targetType: 'leader_pipe_end', labels: [validLabel] } },
    { id: 'current-pending', state: 'pending_local', payload: { targetType: 'leader_pipe_end', pipelineNumberSchemaVersion: 1, labels: [validLabel] } },
    { id: 'old-accepted', state: 'accepted', payload: { targetType: 'leader_pipe_end', labels: [validLabel] }, receiptId: 'receipt' },
    { id: 'stored', state: 'stored', payload: null }
  ]);
  jest.spyOn(service, 'removeQueuedSample').mockResolvedValue(undefined);

  await expect(service.purgeLegacyQueuedSamples()).resolves.toBe(1);
  expect(service.removeQueuedSample).toHaveBeenCalledTimes(1);
  expect(service.removeQueuedSample).toHaveBeenCalledWith('old-pending');
  jest.restoreAllMocks();
});
