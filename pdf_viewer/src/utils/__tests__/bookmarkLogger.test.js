import { bookmarkLogger } from '../bookmarkLogger';

describe('automatic layout diagnostics log', () => {
  test('records page totals and useful per-weld diagnostics', () => {
    const details = bookmarkLogger.buildAutomaticLayoutPageDetails({
      annotations: [
        {
          text: '12',
          page: 3,
          pipelineNumber: '307-A',
          jointTypeText: '',
          startX: 100,
          startY: 120,
          endX: 220,
          endY: 220,
          layoutDiagnostics: {
            lineLength: 156.2,
            family: 'diagonal',
            source: 'local-pipe-band',
            selectionStage: 'perimeter-distribution',
            usedFallback: true,
            hardCollisionCount: 1,
            constraintViolationCount: 0,
            penalty: 321.5
          }
        }
      ]
    });

    expect(details).toEqual(expect.objectContaining({
      annotationCount: 1,
      fallbackCount: 1,
      collisionCount: 1,
      missingJointTypeCount: 1
    }));
    expect(details.items[0]).toEqual(expect.objectContaining({
      weldNumber: '12',
      source: 'local-pipe-band',
      leaderLength: 156.2
    }));
  });

  test('summary identifies the exact page and weld requiring review', () => {
    const session = {
      operationType: 'automatic_layout',
      pdfName: 'sample.pdf',
      startTime: '2026-07-30T01:00:00.000Z',
      userName: 'tester',
      sessionId: 'session-1',
      processedPages: [{
        pageNum: 3,
        details: bookmarkLogger.buildAutomaticLayoutPageDetails({
          annotations: [{
            text: '12',
            pipelineNumber: '307-A',
            startX: 100,
            startY: 120,
            endX: 220,
            endY: 220,
            layoutDiagnostics: {
              family: 'diagonal',
              source: 'local-pipe-band',
              selectionStage: 'perimeter-distribution',
              usedFallback: true,
              hardCollisionCount: 1
            }
          }]
        })
      }]
    };
    const summary = bookmarkLogger.generateAutomaticLayoutSummary(session, {
      totalPages: 1
    });

    expect(summary).toContain('第 3 页');
    expect(summary).toContain('焊点 12');
    expect(summary).toContain('兜底 是');
    expect(summary).toContain('缺少接头形式: 1');
  });
});

describe('weld numbering straight-pipe diagnostics log', () => {
  test('keeps safety-limit material values passed by multi-page numbering', () => {
    const details = bookmarkLogger.buildWeldNumberingPageDetails({
      straightPipeAutoWeld: {
        status: 'skipped',
        reason: '计算出的补点数 119 超过安全上限 100',
        addedCount: 0,
        material: {
          eligible: false,
          steelClass: 'carbon',
          diameterInch: 6,
          rawQuantityValues: ['1200M'],
          parsedLengthsM: [1200],
          totalLengthM: 1200,
          referenceLengthM: 10,
          weldCount: 119,
          safetyLimit: 100,
          pipeRowCount: 1
        }
      }
    });

    expect(details.straightPipeAutoWeld.material).toEqual(expect.objectContaining({
      rawQuantityValues: ['1200M'],
      totalLengthM: 1200,
      referenceLengthM: 10,
      weldCount: 119,
      safetyLimit: 100
    }));
  });

  test('writes the exact over-limit length and count to the persisted text summary', () => {
    const details = bookmarkLogger.buildWeldNumberingPageDetails({
      straightPipeAutoWeld: {
        status: 'skipped',
        reason: '计算出的补点数 119 超过安全上限 100',
        material: {
          rawQuantityValues: ['1200M'],
          parsedLengthsM: [1200],
          totalLengthM: 1200,
          referenceLengthM: 10,
          weldCount: 119,
          safetyLimit: 100
        }
      }
    });
    const summary = bookmarkLogger.generateWeldNumberingSummary({
      operationType: 'weld_numbering',
      pdfName: 'sample.pdf',
      startTime: '2026-08-07T01:00:00.000Z',
      userName: 'tester',
      processedPages: [{ pageNum: 7, details }]
    }, { totalPages: 1 });

    expect(summary).toContain('第 7 页');
    expect(summary).toContain('PIPE QTY 原值: 1200M');
    expect(summary).toContain('总长度: 1200m');
    expect(summary).toContain('计算补点数: 119');
    expect(summary).toContain('安全上限: 100');
    expect(summary).toContain('结论: 超过安全上限');
  });
});
