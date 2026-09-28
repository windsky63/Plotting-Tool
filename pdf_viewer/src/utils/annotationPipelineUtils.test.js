import { buildAnnotationPipelineUpdates } from './annotationPipelineUtils';

describe('buildAnnotationPipelineUpdates', () => {
  test('writes the pipeline to every annotation on matched pages', () => {
    const updates = buildAnnotationPipelineUpdates({
      annotations: [
        { id: 'weld', page: 2, borderShape: 'circle', pipelineNumber: '', weldData: { weldNumber: 1 } },
        { id: 'pipe-tag', page: 2, borderShape: 'pipe-tag' },
        { id: 'rectangle', page: 3, borderShape: 'text-rectangle' },
        { id: 'outside', page: 4, borderShape: 'circle' }
      ],
      pages: [2, 3],
      pipelineNumber: ' pipe-a ',
      pipelineNumberSource: 'ocr_confirmed'
    });
    expect(updates).toEqual({
      weld: { pipelineNumber: 'PIPE-A', pipelineNumberRaw: 'PIPE-A', pipelineNumberSource: 'ocr_confirmed', weldData: { weldNumber: 1, pipelineNumber: 'PIPE-A', pipelineNumberRaw: 'PIPE-A', pipelineNumberSource: 'ocr_confirmed' } },
      'pipe-tag': { pipelineNumber: 'PIPE-A', pipelineNumberRaw: 'PIPE-A', pipelineNumberSource: 'ocr_confirmed' },
      rectangle: { pipelineNumber: 'PIPE-A', pipelineNumberRaw: 'PIPE-A', pipelineNumberSource: 'ocr_confirmed' }
    });
  });

  test('does not emit unchanged updates', () => {
    expect(buildAnnotationPipelineUpdates({
      annotations: [{ id: 'a', page: 1, pipelineNumber: 'PIPE-A', pipelineNumberRaw: 'PIPE-A', pipelineNumberSource: 'business_data' }],
      pages: [1],
      pipelineNumber: 'PIPE-A'
    })).toEqual({});
  });
});
