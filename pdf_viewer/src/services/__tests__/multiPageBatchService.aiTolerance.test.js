import service from '../multiPageBatchService';

beforeEach(() => {
  service.reset();
  jest.spyOn(service, 'getPageInfo').mockReturnValue({ width: 600, height: 800 });
  jest.spyOn(service, 'isWeldInRecognitionArea').mockReturnValue(true);
  service.pageWelds = { 1: [{ id: 'rule', center: { x: 100, y: 100 }, weldNumber: 12 }] };
});
afterEach(() => jest.restoreAllMocks());

test('real multi-page merge uses 5px; a 6px candidate can still be explicitly accepted', () => {
  service.mergeAiWeldDetections({ 1: [
    { id: 'hit', center: { x: 103, y: 104 } },
    { id: 'review', center: { x: 106, y: 100 } },
  ] }, 1, 1);
  expect(service.pageAiWeldDiagnostics[1]).toMatchObject({ mergeDistance: 5, matchedCount: 1, aiOnlyCount: 1 });
  expect(service.pageWelds[1][0].center).toEqual({ x: 100, y: 100 });
  expect(service.pageWeldReviewCandidates[1]).toHaveLength(1);
  const candidate = service.pageWeldReviewCandidates[1][0];
  service.acceptWeldReviewCandidate(1, candidate.reviewId);
  expect(service.pageWelds[1]).toHaveLength(2);
  expect(service.pageWelds[1][1].recognitionSource).toBe('ai-confirmed');
});

test('accepting an AI candidate on the 5px boundary does not create a duplicate', () => {
  service.pageWeldReviewCandidates = { 1: [{ reviewId: 'boundary', reviewSource: 'ai', center: { x: 103, y: 104 } }] };
  service.acceptWeldReviewCandidate(1, 'boundary');
  expect(service.pageWelds[1]).toHaveLength(1);
});

test('AI direct mode replaces rule results without requiring vectors and removes overlapping AI duplicates', () => {
  service.pageTextDetections = {
    1: { pipelineNumber: '100-P-101-A1', pipelineStatus: 'matched', pipelineConfidence: 0.9 }
  };
  service.replaceWeldsWithAiDetections({ 1: [
    { id: 'ai-low', center: { x: 200, y: 300 }, confidence: 0.6 },
    { id: 'ai-high', center: { x: 203, y: 304 }, confidence: 0.9 }
  ] }, 1, 1);
  expect(service.pageWelds[1]).toHaveLength(1);
  expect(service.pageWelds[1][0]).toMatchObject({
    id: 'ai-high',
    recognitionSource: 'ai-direct',
    pipelineNumber: '100-P-101-A1'
  });
  expect(service.pageWeldReviewCandidates[1]).toEqual([]);
  expect(service.pageAiWeldDiagnostics[1]).toMatchObject({
    mode: 'direct',
    vectorRecognitionSkipped: true,
    fittingRecognitionSkipped: true,
    acceptedCount: 1
  });
});
