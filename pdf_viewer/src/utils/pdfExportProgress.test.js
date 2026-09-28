import { getPdfExportProgress } from './pdfExportProgress';

test('export progress follows actual stages, including sparse annotated pages', () => {
  const steps = [
    ...['loading', 'loaded', 'metadata', 'serializing', 'generated'].map(phase => ({ kind: 'editable', phase })),
    ...['loading', 'loaded'].map(phase => ({ kind: 'annotated', phase })),
    { phase: 'rendering', completedPages: 0, totalPages: 2 },
    { phase: 'rendering', completedPages: 1, totalPages: 2, pageNumber: 1 },
    { phase: 'rendering', completedPages: 2, totalPages: 2, pageNumber: 80 },
    { phase: 'serializing' },
    { phase: 'generated' },
  ].map(getPdfExportProgress);
  const percentages = steps.map(step => step.percent);
  expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
  expect(steps[9].status).toContain('2/2');
  expect(steps[9].status).toContain('80');
  expect(steps.at(-1).percent).toBeLessThan(100);
});

test('empty rendering workload never produces NaN', () => {
  expect(getPdfExportProgress({ phase: 'rendering' }).percent).toBe(18);
});

test('serialization progress advances without claiming download completion', () => {
  expect(getPdfExportProgress({ phase: 'serializing', kind: 'annotated', totalSteps: 100, completedSteps: 50, stage: 'sizing' }).percent).toBe(94);
  expect(getPdfExportProgress({ phase: 'serializing', kind: 'annotated', totalSteps: 100, completedSteps: 100, stage: 'writing' }).percent).toBe(98);
});
