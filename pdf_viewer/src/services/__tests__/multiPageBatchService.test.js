import multiPageBatchService from '../multiPageBatchService';
import ocrService from '../ocrService';

describe('multiPageBatchService text recognition reuse', () => {
  beforeEach(() => {
    multiPageBatchService.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reuses pipeline number and pipe class saved by material recognition', async () => {
    multiPageBatchService.pageTextDetections = {
      4: {
        pipelineNumber: 'PIPE-004',
        pipeClass: 'CL150'
      }
    };
    ocrService.port = ocrService.port || 8866;
    const detectSpy = jest.spyOn(ocrService, 'detectTextOnly').mockResolvedValue({
      detections: [],
      page_info: { page_width: 1000, page_height: 700 }
    });

    await multiPageBatchService.detectTextFromPages('sample.pdf', 4, 4, {
      pipelineArea: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      pipeClassArea: { x: 0.4, y: 0.1, width: 0.2, height: 0.1 }
    });

    expect(detectSpy).toHaveBeenCalledWith(
      'sample.pdf',
      4,
      expect.objectContaining({
        preRecognizedPipelineNumber: 'PIPE-004',
        preRecognizedPipeClass: 'CL150',
        pipelineArea: expect.objectContaining({ page: 4 }),
        pipeClassArea: expect.objectContaining({ page: 4 })
      })
    );
  });

  test('does not reuse a numeric-only OCR result as the material pipeline number', async () => {
    multiPageBatchService.pageTextDetections = {
      4: { pipelineNumber: '307', pipeClass: '150' }
    };
    ocrService.port = ocrService.port || 8866;
    const detectSpy = jest.spyOn(ocrService, 'detectTextOnly').mockResolvedValue({
      detections: [],
      page_info: { page_width: 1000, page_height: 700 }
    });

    await multiPageBatchService.detectTextFromPages('sample.pdf', 4, 4, {
      pipelineArea: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      pipeClassArea: { x: 0.4, y: 0.1, width: 0.2, height: 0.1 }
    });

    expect(detectSpy).toHaveBeenCalledWith(
      'sample.pdf',
      4,
      expect.objectContaining({
        preRecognizedPipelineNumber: '',
        preRecognizedPipeClass: '',
        pipelineArea: expect.objectContaining({ page: 4 }),
        pipeClassArea: expect.objectContaining({ page: 4 })
      })
    );
  });
});

describe('multi-page fitting and weld integration', () => {
  beforeEach(() => {
    multiPageBatchService.reset();
  });

  test('applies OL only to the branch-outlet weld connected to the main run', () => {
    multiPageBatchService.pageWelds = {
      1: [
        { id: 'branch-weld', center: { x: 100, y: 93 }, boundingBox: { minX: 97, minY: 90, width: 6, height: 6 } },
        { id: 'main-weld', center: { x: 100, y: 102 }, boundingBox: { minX: 97, minY: 99, width: 6, height: 6 } }
      ]
    };

    multiPageBatchService.applyFittingEvidenceToPageWelds(1, [{
      branchOutlet: true,
      type: 'tee-fitting',
      center: { x: 100, y: 98 },
      mainConnectionPoint: { x: 100, y: 102 },
      branchConnectionPoint: { x: 100, y: 93 },
      score: 0.9
    }], { page_width: 600, page_height: 600 });

    const main = multiPageBatchService.pageWelds[1].find(weld => weld.id === 'main-weld');
    const branch = multiPageBatchService.pageWelds[1].find(weld => weld.id === 'branch-weld');
    expect(main.annotationJointTypeText).toBe('OL');
    expect(main.detectedFittings[0]).toMatchObject({ type: 'branch-outlet', role: 'main-connection' });
    expect(branch.annotationJointTypeText).toBeUndefined();
    expect(branch.detectedFittings[0]).toMatchObject({ type: 'branch-outlet', role: 'branch-connection' });
  });

  test('keeps an existing per-weld correction above detected OL evidence', () => {
    multiPageBatchService.pageWelds = {
      1: [{
        id: 'main-weld',
        center: { x: 100, y: 102 },
        annotationJointTypeText: 'RR'
      }]
    };

    multiPageBatchService.applyFittingEvidenceToPageWelds(1, [{
      branchOutlet: true,
      type: 'tee-fitting',
      center: { x: 100, y: 102 },
      mainConnectionPoint: { x: 100, y: 102 },
      score: 0.9
    }], { page_width: 600, page_height: 600 });

    expect(multiPageBatchService.pageWelds[1][0].annotationJointTypeText).toBe('RR');
  });

  test('keeps detector weld identities when cached coordinates point at the wrong side', () => {
    multiPageBatchService.pageWelds = {
      1: [
        { id: 'branch-weld', center: { x: 100, y: 93 } },
        { id: 'main-weld', center: { x: 100, y: 102 } }
      ]
    };

    multiPageBatchService.applyFittingEvidenceToPageWelds(1, [{
      branchOutlet: true,
      type: 'tee-fitting',
      center: { x: 100, y: 98 },
      mainConnectionWeldId: 'main-weld',
      branchConnectionWeldId: 'branch-weld',
      // Simulate stale/scaled points from an older preview snapshot.
      mainConnectionPoint: { x: 100, y: 93 },
      branchConnectionPoint: { x: 100, y: 102 },
      score: 0.9
    }], { page_width: 600, page_height: 600 });

    expect(multiPageBatchService.pageWelds[1].find(weld => weld.id === 'main-weld').annotationJointTypeText).toBe('OL');
    expect(multiPageBatchService.pageWelds[1].find(weld => weld.id === 'branch-weld').annotationJointTypeText).toBeUndefined();
  });

  test('detects an outlet when its description exists only in rawLogicalRow', async () => {
    const line = (x1, y1, x2, y2, pathId) => [0, x1, y1, x2, y2, 0, 1, pathId];
    multiPageBatchService.pageVectors = {
      1: [
        line(640.9, 508.7, 635.8, 505.8, 199),
        line(635.8, 505.8, 631.6, 511.2, 199),
        line(631.6, 511.2, 635.8, 521.4, 199),
        line(635.8, 521.4, 646.0, 527.4, 199),
        line(646.0, 527.4, 650.3, 522.0, 199),
        line(650.3, 522.0, 646.0, 511.6, 199),
        line(646.0, 511.6, 640.9, 508.7, 199),
        line(668.6, 524.5, 640.9, 508.7, 197),
        line(640.9, 508.7, 616.8, 494.8, 214),
        line(0, 0, 1683.78, 0, 'page-width'),
        line(0, 0, 0, 1190.55, 'page-height')
      ]
    };
    multiPageBatchService.pageWelds = {
      1: [
        { id: 'upper', center: { x: 640.95, y: 508.65 } },
        { id: 'lower', center: { x: 640.95, y: 524.25 } }
      ]
    };
    multiPageBatchService.pageTextDetections = {
      1: { detections: [], page_info: { page_width: 1683.78, page_height: 1190.55 } }
    };

    const result = await multiPageBatchService.detectFittingsFromPages(1, 1, null, {
      1: [{
        description: 'I249524059',
        quantity: '',
        rawLogicalRow: ['3', 'I249524059', '400X25', '', 'WELDING OUTLET A105N BW MSS SP-97', '1']
      }]
    });

    expect(result[1].filter(candidate => candidate.branchOutlet)).toHaveLength(1);
    expect(multiPageBatchService.pageWelds[1].find(weld => weld.id === 'upper').annotationJointTypeText).toBe('OL');
  });

  test('uses the uniquely matched outlet material for both sides and OL only on the main side', () => {
    multiPageBatchService.allWelds = [
      {
        id: 'main-weld', pageNum: 1, weldNumber: 5, center: { x: 100, y: 102 },
        detectedFittings: [{ type: 'branch-outlet', role: 'main-connection', candidateIndex: 0 }]
      },
      {
        id: 'branch-weld', pageNum: 1, weldNumber: 6, center: { x: 100, y: 93 },
        detectedFittings: [{ type: 'branch-outlet', role: 'branch-connection', candidateIndex: 0 }]
      }
    ];
    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      {
        frameSize: 56.7,
        borderShape: 'split-circle',
        batchContent: {
          diameterSource: 'material',
          jointTypeSource: 'material',
          materialRowsByPage: {
            1: [{ description: 'WELDING OUTLET A105N BW MSS SP-97', specification: 'DN200' }]
          }
        }
      },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 1: [] },
        pageTextDetections: { 1: { detections: [], page_info: { page_width: 600, page_height: 600 } } }
      }
    );

    expect(annotations.find(item => String(item.text) === '5')).toMatchObject({ topText: '8', jointTypeText: 'OL' });
    expect(annotations.find(item => String(item.text) === '6')).toMatchObject({ topText: '8', jointTypeText: 'BW' });
  });
});

describe('multiPageBatchService pipeline comparison state', () => {
  beforeEach(() => {
    multiPageBatchService.reset();
  });

  test('已有统计结果时设置 Excel 基准会立即生成对账结果', () => {
    multiPageBatchService.pipelineStats = [
      {
        key: 'PIPE-001',
        pipelineNumber: 'PIPE-001',
        weldCount: 2,
        pages: [1],
        pagesText: '1',
        numberRangeText: '1 - 2',
        candidateCount: 1,
        sourceText: 'paddleocr'
      }
    ];

    multiPageBatchService.setPipelineReferenceData({
      items: [
        { pipelineNumber: 'PIPE-001', expectedWeldCount: 2 }
      ]
    });

    const comparison = multiPageBatchService.getPipelineComparison();
    expect(comparison).not.toBeNull();
    expect(comparison.items).toHaveLength(1);
    expect(comparison.items[0].compareStatus).toBe('matched');
  });

  test('未导入基准数据时不会生成对账结果', () => {
    multiPageBatchService.pipelineStats = [
      {
        key: 'PIPE-002',
        pipelineNumber: 'PIPE-002',
        weldCount: 1,
        pages: [2],
        pagesText: '2',
        numberRangeText: '3 - 3',
        candidateCount: 1,
        sourceText: 'paddleocr'
      }
    ];

    expect(multiPageBatchService.getPipelineComparison()).toBeNull();
  });

  test('reset 会清空 Excel 基准与对账结果', () => {
    multiPageBatchService.pipelineStats = [
      {
        key: 'PIPE-003',
        pipelineNumber: 'PIPE-003',
        weldCount: 3,
        pages: [3],
        pagesText: '3',
        numberRangeText: '4 - 6',
        candidateCount: 1,
        sourceText: 'paddleocr'
      }
    ];

    multiPageBatchService.setPipelineReferenceData({
      items: [
        { pipelineNumber: 'PIPE-003', expectedWeldCount: 2 }
      ]
    });

    expect(multiPageBatchService.getPipelineReferenceData()).not.toBeNull();
    expect(multiPageBatchService.getPipelineComparison()).not.toBeNull();

    multiPageBatchService.reset();

    expect(multiPageBatchService.getPipelineReferenceData()).toBeNull();
    expect(multiPageBatchService.getPipelineComparison()).toBeNull();
    expect(multiPageBatchService.getPipelineStats()).toEqual([]);
  });

  test('只重置编号时保留识别结果并移除后加的补点', () => {
    const recognizedWeld = { id: 'recognized', center: { x: 10, y: 10 } };
    multiPageBatchService.pageVectors = { 1: [[0, 0, 0, 1, 1, 0, 1, 1]] };
    multiPageBatchService.pageTextDetections = { 1: { pipelineNumber: 'PIPE-1' } };
    multiPageBatchService.pageWelds = {
      1: [
        recognizedWeld,
        { id: 'manual', isManualInserted: true },
        { id: 'auto-pipe', isAutoPipeLengthInserted: true }
      ]
    };
    multiPageBatchService.pagePipelines = { 1: { mainPipes: [] } };
    multiPageBatchService.allWelds = [{ ...recognizedWeld, weldNumber: 1 }];
    multiPageBatchService.allWeldsNumbered = [{ ...recognizedWeld, weldNumber: 1 }];
    multiPageBatchService.pipelineStats = [{ pipelineNumber: 'PIPE-1', weldCount: 1 }];
    multiPageBatchService.pipelineReferenceData = { items: [{ pipelineNumber: 'PIPE-1' }] };
    multiPageBatchService.pendingBatchAnnotationRule = { id: 'rule-1' };
    multiPageBatchService.activeBatchRunId = 'batch-1';

    multiPageBatchService.resetNumberingState();

    expect(multiPageBatchService.pageVectors[1]).toHaveLength(1);
    expect(multiPageBatchService.pageTextDetections[1].pipelineNumber).toBe('PIPE-1');
    expect(multiPageBatchService.pageWelds[1]).toEqual([recognizedWeld]);
    expect(multiPageBatchService.pagePipelines[1]).toBeDefined();
    expect(multiPageBatchService.getPipelineReferenceData()).not.toBeNull();
    expect(multiPageBatchService.getAllWelds()).toEqual([]);
    expect(multiPageBatchService.getPipelineStats()).toEqual([]);
    expect(multiPageBatchService.getPendingBatchAnnotationRule()).toBeNull();
    expect(multiPageBatchService.getStatus().currentStep).toBe('pipelines');
  });
});

describe('multiPageBatchService material-table notices', () => {
  beforeEach(() => {
    multiPageBatchService.reset();
  });

  test('JPLATE is declared from a saved material row even when OCR shifts its column', () => {
    const notices = multiPageBatchService.detectSupportNoticesFromMaterialResults({
      6: {
        materials: [{
          description: 'PSL',
          quantity: 'JPLATE',
          rawLogicalRow: ['6', 'PSL', '100', '', 'JPLATE', '9']
        }]
      }
    }, 6, 6);

    expect(notices[6]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'positioning-block',
        pageNum: 6,
        label: 'JPLATE',
        source: 'saved-material-recognition'
      })
    ]));
  });
});

describe('multiPageBatchService annotation layout context', () => {
  beforeEach(() => {
    multiPageBatchService.reset();
  });

  test('最终生成显式采用预览当前焊点区域，而不是服务中的旧缓存', () => {
    multiPageBatchService.allWelds = [
      [90, 90],
      [300, 80],
      [510, 90],
      [520, 300],
      [510, 510],
      [300, 520],
      [90, 510],
      [80, 300]
    ].map(([x, y], index) => ({
      pathId: index + 1,
      page: 1,
      pageNum: 1,
      number: index + 1,
      weldNumber: index + 1,
      displayNumber: String(index + 1),
      center: { x, y },
      boundingBox: {
        minX: x - 3,
        minY: y - 3,
        width: 6,
        height: 6
      }
    }));
    multiPageBatchService.weldRecognitionArea = null;

    const area = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      { frameSize: 56.7, borderShape: 'circle' },
      'KEEP_ORDER',
      null,
      {
        weldRecognitionArea: area,
        pageVectors: { 1: [] },
        pageTextDetections: {
          1: {
            detections: [],
            page_info: { page_width: 600, page_height: 600 }
          }
        }
      }
    );

    const radius = 56.7 / 2;
    annotations.forEach(annotation => {
      expect(annotation.layoutDiagnostics).toEqual(expect.objectContaining({
        selectionStage: expect.any(String),
        lineLength: expect.any(Number)
      }));
      expect(annotation.endX - radius).toBeGreaterThanOrEqual(120);
      expect(annotation.endY - radius).toBeGreaterThanOrEqual(120);
      expect(annotation.endX + radius).toBeLessThanOrEqual(1080);
      expect(annotation.endY + radius).toBeLessThanOrEqual(1080);
    });
  });

  test('最终标注使用当前规范编号并修正旧的显示编号', () => {
    multiPageBatchService.allWelds = [{
      id: 'page-2-first',
      page: 2,
      pageNum: 2,
      number: 26,
      weldNumber: 26,
      displayNumber: 'F42',
      center: { x: 200, y: 200 },
      boundingBox: {
        minX: 197,
        minY: 197,
        width: 6,
        height: 6
      }
    }];

    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      { frameSize: 56.7, borderShape: 'circle' },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 2: [] },
        pageTextDetections: {
          2: {
            detections: [],
            page_info: { page_width: 600, page_height: 600 }
          }
        }
      }
    );

    expect(annotations).toHaveLength(1);
    expect(annotations[0].text).toBe('F26');
    expect(annotations[0].weldData.weldNumber).toBe(26);
  });

  test('去编号焊点即使残留旧显示值也始终生成空内容', () => {
    multiPageBatchService.allWelds = [{
      id: 'numberless-weld',
      page: 1,
      pageNum: 1,
      number: '',
      weldNumber: null,
      displayNumber: 'F42',
      isNumberless: true,
      center: { x: 200, y: 200 },
      boundingBox: {
        minX: 197,
        minY: 197,
        width: 6,
        height: 6
      }
    }];

    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      { frameSize: 56.7, borderShape: 'circle' },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 1: [] },
        pageTextDetections: {
          1: {
            detections: [],
            page_info: { page_width: 600, page_height: 600 }
          }
        }
      }
    );

    expect(annotations).toHaveLength(1);
    expect(annotations[0].text).toBe('');
  });

  test('将页面识别到的管道等级传入最终标注', () => {
    multiPageBatchService.allWelds = [{
      id: 'pipe-class-weld',
      page: 1,
      pageNum: 1,
      weldNumber: 1,
      displayNumber: '1',
      pipelineNumber: '001-P/A',
      center: { x: 200, y: 200 },
      boundingBox: { minX: 197, minY: 197, width: 6, height: 6 }
    }];

    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      { frameSize: 56.7, borderShape: 'circle' },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 1: [] },
        pageTextDetections: {
          1: {
            detections: [],
            pipeClass: '1C2',
            pipelineSource: 'mineru-full-page',
            page_info: { page_width: 600, page_height: 600 }
          }
        }
      }
    );

    expect(annotations[0].pipeClass).toBe('1C2');
    expect(annotations[0].pipelineClass).toBe('1C2');
    expect(annotations[0].weldData.pipeClass).toBe('1C2');
    expect(annotations[0]).toMatchObject({
      pipelineNumber: '001-P/A',
      pipelineNumberRaw: '001-P/A',
      pipelineNumberSource: 'inferred'
    });
    expect(annotations[0].weldData.pipelineNumberSource).toBe('inferred');
  });

  test('自动落图按焊口号范围为较小 PIPE 寸径生成最终标注', () => {
    multiPageBatchService.allWelds = [
      { id: 'main-1', weldNumber: 1, displayNumber: '1', center: { x: 120, y: 180 } },
      { id: 'branch-67', weldNumber: 67, displayNumber: '67', center: { x: 360, y: 180 } }
    ].map(weld => ({
      ...weld,
      page: 1,
      pageNum: 1,
      pipelineNumber: 'PIPE-A',
      boundingBox: {
        minX: weld.center.x - 3,
        minY: weld.center.y - 3,
        maxX: weld.center.x + 3,
        maxY: weld.center.y + 3
      }
    }));

    const annotations = multiPageBatchService.convertWeldsToAnnotations(
      1,
      {
        frameSize: 56.7,
        borderShape: 'split-circle',
        batchContent: {
          diameterSource: 'material',
          jointTypeSource: 'manual',
          manualJointType: 'BW',
          materialRowsByPage: {
            1: [
              { specification: '450', description: 'PIPE A106 SMLS', pipelineNumber: 'PIPE-A' },
              { specification: '450', description: 'PIPE A106 SMLS', pipelineNumber: 'PIPE-A' },
              { specification: '300', description: 'PIPE A106 SMLS', pipelineNumber: 'PIPE-A' }
            ]
          },
          diameterRangesByPage: { 1: { 12: '67-70' } }
        }
      },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 1: [] },
        pageTextDetections: { 1: { detections: [], page_info: { page_width: 600, page_height: 600 } } }
      }
    );

    expect(annotations.find(item => item.text === '1').topText).toBe('18');
    expect(annotations.find(item => item.text === '67').topText).toBe('12');
  });

  test('焊接支架使用独立的601序列且不占普通焊口编号', () => {
    const weld = (id, x, extra = {}) => ({
      id,
      center: { x, y: 200 },
      boundingBox: { minX: x - 3, minY: 197, width: 6, height: 6 },
      ...extra
    });
    multiPageBatchService.pageTextDetections = {
      1: { pipelineNumber: 'PIPE-1' },
      2: { pipelineNumber: 'PIPE-1' }
    };
    multiPageBatchService.pageWelds = {
      1: [
        weld('regular-1', 100),
        weld('support-1', 200, { isWeldedSupport: true, supportCode: 'TR1' }),
        weld('regular-2', 300)
      ],
      2: [weld('support-2', 400, { isWeldedSupport: true, supportCode: 'RV3' })]
    };

    const numbered = multiPageBatchService.generateWeldNumbers(1, 2, 1, 'F');
    expect(numbered.filter(item => !item.isWeldedSupport).map(item => item.displayNumber)).toEqual(['F1', 'F2']);
    expect(numbered.filter(item => item.isWeldedSupport).map(item => item.displayNumber)).toEqual(['601', '602']);
  });

  test('焊接支架忽略支架型号，仅在管线号变化时从601重新编号', () => {
    const support = (id, supportCode) => ({
      id,
      center: { x: 100, y: 200 },
      boundingBox: { minX: 97, minY: 197, width: 6, height: 6 },
      isWeldedSupport: true,
      supportCode
    });
    multiPageBatchService.pageTextDetections = {
      1: { pipelineNumber: 'PIPE-A' },
      2: { pipelineNumber: 'PIPE-A' },
      3: { pipelineNumber: 'PIPE-B' }
    };
    multiPageBatchService.pageWelds = {
      1: [support('support-1', 'TR1')],
      2: [support('support-2', 'RV3')],
      3: [support('support-3', 'TR1')]
    };

    const numbered = multiPageBatchService.generateWeldNumbers(1, 3, 1, 'F');
    expect(numbered.filter(item => item.isWeldedSupport).map(item => item.displayNumber)).toEqual([
      '601', '602', '601'
    ]);
  });

  test('焊接支架最终标注强制为空寸径、AW接头和分栏圆形', () => {
    multiPageBatchService.allWelds = [{
      id: 'support-weld',
      page: 1,
      pageNum: 1,
      weldNumber: 601,
      displayNumber: '601',
      isWeldedSupport: true,
      supportCode: 'A1S3',
      center: { x: 200, y: 200 },
      boundingBox: { minX: 197, minY: 197, width: 6, height: 6 }
    }];

    const [annotation] = multiPageBatchService.convertWeldsToAnnotations(
      1,
      {
        frameSize: 56.7,
        borderShape: 'circle',
        batchContent: { diameterSource: 'manual', manualDiameter: '6', jointTypeSource: 'manual', manualJointType: 'BW' }
      },
      'KEEP_ORDER',
      null,
      {
        pageVectors: { 1: [] },
        pageTextDetections: { 1: { detections: [], page_info: { page_width: 600, page_height: 600 } } }
      }
    );

    expect(annotation).toMatchObject({
      text: '601',
      topText: '',
      jointTypeText: 'AW',
      borderShape: 'split-circle',
      isWeldedSupport: true,
      supportCode: 'A1S3'
    });
  });
});
