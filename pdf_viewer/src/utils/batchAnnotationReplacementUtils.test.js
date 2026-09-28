import { buildAnnotationReplacementPlan } from './batchAnnotationReplacementUtils';

describe('batch annotation replacement scope', () => {
  test('manual supplement never removes untouched pages that share the batch id', () => {
    const existing = [
      { id: 'page-137-old', page: 137, batchRunId: 'batch-a' },
      { id: 'page-138-old', page: 138, batchRunId: 'batch-a' },
      { id: 'page-139-old', page: 139, batchRunId: 'batch-a' }
    ];
    const incoming = [
      {
        id: 'page-138-updated',
        page: 138,
        batchRunId: 'batch-a',
        weldData: { sourceAnnotationId: 'page-138-old' }
      },
      {
        id: 'page-138-manual',
        page: 138,
        batchRunId: 'batch-a',
        weldData: { isManualInserted: true, manualInsertId: 'manual-1' }
      }
    ];
    const plan = buildAnnotationReplacementPlan(existing, incoming);

    expect(plan.replaceWholeBatch).toBe(false);
    expect(plan.replacedAnnotations.map(annotation => annotation.id)).toEqual(['page-138-old']);
    expect(existing.filter(annotation => !plan.shouldReplace(annotation)).map(annotation => annotation.id)).toEqual([
      'page-137-old',
      'page-139-old'
    ]);
  });

  test('manual deletion removes the explicit deleted id but keeps neighboring pages', () => {
    const existing = [
      { id: 'before', page: 1, batchRunId: 'batch-a' },
      { id: 'deleted', page: 2, batchRunId: 'batch-a' },
      { id: 'after', page: 3, batchRunId: 'batch-a' }
    ];
    const incoming = [{
      id: 'manual-marker',
      batchRunId: 'batch-a',
      replacementSourceAnnotationIds: ['deleted'],
      weldData: { isManualInserted: true }
    }];
    const plan = buildAnnotationReplacementPlan(existing, incoming);

    expect(plan.replacedAnnotations.map(annotation => annotation.id)).toEqual(['deleted']);
  });

  test('legacy automatic regeneration without source ids may replace its whole batch', () => {
    const existing = [
      { id: 'old-a', batchRunId: 'batch-a' },
      { id: 'other', batchRunId: 'batch-b' }
    ];
    const incoming = [{ id: 'new-a', batchRunId: 'batch-a' }];
    const plan = buildAnnotationReplacementPlan(existing, incoming);

    expect(plan.replaceWholeBatch).toBe(true);
    expect(plan.replacedAnnotations.map(annotation => annotation.id)).toEqual(['old-a']);
  });
});
