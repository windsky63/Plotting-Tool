import fs from 'fs';
import multiPageBatchService from '../services/multiPageBatchService';
import { detectBranchOutletCandidates } from './TeeDetector';

jest.setTimeout(60000);

const fixturePath = process.env.OUTLET_VECTOR_FIXTURE;
const run = fixturePath && fs.existsSync(fixturePath) ? test : test.skip;

run('reports deterministic branch-outlet recognition on a real extracted page', async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const expectedQty = Number.isFinite(Number(fixture.expectedQty))
    ? Math.max(0, Math.round(Number(fixture.expectedQty)))
    : 1;
  const materialRows = {
    1: [{
      description: 'I249524059',
      quantity: 'WELDING OUTLET A105N BW MSS SP-97 DN400 S-30 X 25 S-80',
      rawLogicalRow: [
        '3', 'I249524059', '400X25', '',
        'WELDING OUTLET A105N BW MSS SP-97 DN400 S-30 X 25 S-80', String(expectedQty)
      ]
    }]
  };

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const recognize = async () => {
    multiPageBatchService.reset();
    multiPageBatchService.pageVectors = { 1: fixture.vectors };
    multiPageBatchService.pageTextDetections = {
      1: { detections: [], page_info: fixture.pageInfo }
    };
    await multiPageBatchService.detectWeldsFromPages(1, 1, false, null);
    const rawOutlets = detectBranchOutletCandidates(fixture.vectors, {
      welds: multiPageBatchService.pageWelds[1]
    });
    const fittings = await multiPageBatchService.detectFittingsFromPages(1, 1, null, materialRows);
    return {
      welds: multiPageBatchService.pageWelds[1],
      rawOutlets,
      outlets: fittings[1].filter(item => item.branchOutlet)
    };
  };

  const first = await recognize();
  const second = process.env.OUTLET_REPEAT_CHECK === 'false' ? first : await recognize();
  const summarize = result => ({
    sourcePage: fixture.sourcePage || 1,
    expectedQty,
    weldCount: result.welds.length,
    rawOutletCount: result.rawOutlets.length,
    rawOutlets: result.rawOutlets.map(item => ({
      center: item.center,
      mainConnectionPoint: item.mainConnectionPoint,
      branchConnectionPoint: item.branchConnectionPoint,
      connectorCount: item.connectorCount,
      score: item.score
    })),
    outletCount: result.outlets.length,
    outlets: result.outlets.map(item => ({
      center: item.center,
      mainConnectionPoint: item.mainConnectionPoint,
      branchConnectionPoint: item.branchConnectionPoint,
      connectorCount: item.connectorCount,
      score: item.score
    })),
    olWelds: result.welds
      .filter(weld => weld.annotationJointTypeText === 'OL')
      .map(weld => ({ id: weld.id, center: weld.center }))
  });

  // Kept as a diagnostic assertion: repeated recognition must be identical.
  expect(summarize(second)).toEqual(summarize(first));
  logSpy.mockRestore();
  warnSpy.mockRestore();
  // eslint-disable-next-line no-console
  console.log('REAL_BRANCH_OUTLET_DIAGNOSTIC', JSON.stringify(summarize(first)));
});
