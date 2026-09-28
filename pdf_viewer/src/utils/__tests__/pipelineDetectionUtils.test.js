import {
  sanitizeRecognizedPipelineNumber,
  enrichTextDetectionResult,
  detectPipelineReferenceColumns,
  buildPipelineReferenceSummary,
  buildPipelineComparison,
  getPipelineComparisonSummary
} from '../pipelineDetectionUtils';

describe('sanitizeRecognizedPipelineNumber', () => {
  test('rejects numeric-only OCR results but preserves real pipeline identifiers', () => {
    expect(sanitizeRecognizedPipelineNumber('1')).toBe('');
    expect(sanitizeRecognizedPipelineNumber(' 307 ')).toBe('');
    expect(sanitizeRecognizedPipelineNumber(` ${String.fromCharCode(0xFF11)} `)).toBe('');
    expect(sanitizeRecognizedPipelineNumber('１２３')).toBe('');
    expect(sanitizeRecognizedPipelineNumber('LINE-1')).toBe('LINE-1');
    expect(sanitizeRecognizedPipelineNumber('101-A')).toBe('101-A');
  });

  test('marks an explicit numeric-only pipeline result as unresolved', () => {
    const result = enrichTextDetectionResult({
      pipelineNumber: '307',
      pipelineStatus: 'matched',
      pipelineSource: 'material-recognition',
      detections: [],
      page_info: { page_width: 1000, page_height: 700 }
    }, 1);

    expect(result.pipelineNumber).toBe('');
    expect(result.pipelineStatus).toBe('unresolved');
  });
});

describe('pipelineDetectionUtils', () => {
  test('能自动识别常见 Excel 表头', () => {
    const result = detectPipelineReferenceColumns(['序号', '管线号', '焊缝数量', '备注']);

    expect(result.matched).toBe(true);
    expect(result.pipelineColumnIndex).toBe(1);
    expect(result.countColumnIndex).toBe(2);
  });

  test('导入时会清洗管线号并聚合重复管线数量', () => {
    const summary = buildPipelineReferenceSummary([
      ['管线号', '焊点数量'],
      ['ab－001', '2'],
      ['AB-001', '3'],
      ['CD-002', '1']
    ], {
      sheetName: 'Sheet1',
      sourceFileName: 'reference.xlsx',
      pipelineColumnIndex: 0,
      countColumnIndex: 1
    });

    expect(summary.itemCount).toBe(2);
    expect(summary.duplicateCount).toBe(1);
    expect(summary.totalExpectedWeldCount).toBe(6);
    expect(summary.items.find(item => item.pipelineNumber === 'AB-001')?.expectedWeldCount).toBe(5);
  });

  test('对账时会忽略末尾括号编号并按主管线归并', () => {
    const summary = buildPipelineReferenceSummary([
      ['管线号', '焊点数量'],
      ['LINE-010(PD05)', '3'],
      ['LINE-010', '2']
    ], {
      sheetName: 'Sheet1',
      sourceFileName: 'reference.xlsx',
      pipelineColumnIndex: 0,
      countColumnIndex: 1
    });

    const comparison = buildPipelineComparison(summary, [
      {
        key: 'LINE-010',
        pipelineNumber: 'LINE-010',
        pages: [1],
        pagesText: '1',
        weldCount: 1,
        numberStart: 1,
        numberEnd: 1,
        numberRangeText: '1 - 1',
        candidateCount: 1,
        sourceText: 'paddleocr'
      },
      {
        key: 'LINE-010(PD99)',
        pipelineNumber: 'LINE-010(PD99)',
        pages: [2, 3],
        pagesText: '2, 3',
        weldCount: 4,
        numberStart: 2,
        numberEnd: 5,
        numberRangeText: '2 - 5',
        candidateCount: 2,
        sourceText: 'paddleocr'
      }
    ]);

    expect(summary.itemCount).toBe(1);
    expect(summary.items[0]?.pipelineNumber).toBe('LINE-010');
    expect(summary.items[0]?.expectedWeldCount).toBe(5);
    expect(comparison.items).toHaveLength(1);
    expect(comparison.items[0]?.pipelineNumber).toBe('LINE-010');
    expect(comparison.items[0]?.actualWeldCount).toBe(5);
    expect(comparison.items[0]?.compareStatus).toBe('matched');
    expect(comparison.items[0]?.pages).toEqual([1, 2, 3]);
  });

  test('严格模式下只保留批量处理结果中的管线，并生成数量不一致、Excel缺失与未识别异常', () => {
    const summary = buildPipelineReferenceSummary([
      ['管线', '数量'],
      ['LINE-001', '3'],
      ['LINE-002', '2']
    ], {
      pipelineColumnIndex: 0,
      countColumnIndex: 1
    });

    const comparison = buildPipelineComparison(summary, [
      {
        key: 'LINE-001',
        pipelineNumber: 'LINE-001',
        pages: [1, 2],
        pagesText: '1, 2',
        weldCount: 4,
        numberRangeText: '1 - 4',
        candidateCount: 2,
        sourceText: 'paddleocr'
      },
      {
        key: 'LINE-003',
        pipelineNumber: 'LINE-003',
        pages: [3],
        pagesText: '3',
        weldCount: 1,
        numberRangeText: '5 - 5',
        candidateCount: 1,
        sourceText: 'paddleocr'
      },
      {
        key: '__UNRESOLVED_PIPELINE__',
        pipelineNumber: '',
        pages: [4],
        pagesText: '4',
        weldCount: 2,
        numberRangeText: '6 - 7',
        candidateCount: 0,
        sourceText: 'paddleocr'
      }
    ]);

    expect(comparison).not.toBeNull();
    expect(comparison.items.find(item => item.pipelineNumber === 'LINE-001')?.compareStatus).toBe('count_mismatch');
    expect(comparison.items.find(item => item.pipelineNumber === 'LINE-002')).toBeUndefined();
    expect(comparison.items.find(item => item.pipelineNumber === 'LINE-003')?.compareStatus).toBe('missing_in_excel');
    expect(comparison.items.find(item => item.compareStatus === 'unresolved_pipeline')?.pages).toEqual([4]);
    expect(comparison.alertsByPage[1]?.[0]?.compareStatus).toBe('count_mismatch');
    expect(comparison.alertsByPage[3]?.[0]?.compareStatus).toBe('missing_in_excel');
    expect(comparison.alertsByPage[4]?.[0]?.compareStatus).toBe('unresolved_pipeline');
    expect(comparison.summary.missingInPdfCount).toBe(0);
  });

  test('对账汇总会正确统计匹配与异常数量', () => {
    const summary = getPipelineComparisonSummary([
      { compareStatus: 'matched', pages: [1] },
      { compareStatus: 'count_mismatch', pages: [2] },
      { compareStatus: 'missing_in_pdf', pages: [] },
      { compareStatus: 'missing_in_excel', pages: [3] },
      { compareStatus: 'unresolved_pipeline', pages: [4, 5] }
    ]);

    expect(summary.totalItems).toBe(5);
    expect(summary.matchedCount).toBe(1);
    expect(summary.abnormalCount).toBe(4);
    expect(summary.countMismatchCount).toBe(1);
    expect(summary.missingInPdfCount).toBe(1);
    expect(summary.missingInExcelCount).toBe(1);
    expect(summary.unresolvedCount).toBe(1);
    expect(summary.alertPageCount).toBe(5);
  });
});
