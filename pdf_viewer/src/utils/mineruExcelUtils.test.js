import * as XLSX from 'xlsx';
import { parseMineruExcelLogicalRows } from './mineruExcelUtils';

test('repairs shifted Shen Yuan material description and QTY columns', () => {
  const sourceRows = [
    ['PART NO.', 'ITEM CODE', 'SIZE(MM)', 'ACC', 'MATERIAL DESCRIPTION', 'QTY', '管线号', '页'],
    ['2', '1239026658', '450', '90 DEG ELBOW A234GR.WP8 SMLS BW ASME B16.9450 S-STD', '8', '', '3025002-FLG-307', '1']
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sourceRows), '汇总数据');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });

  expect(parseMineruExcelLogicalRows(buffer)).toEqual([[
    '2',
    '1239026658',
    '450',
    '',
    '90 DEG ELBOW A234GR.WP8 SMLS BW ASME B16.9450 S-STD',
    '8',
    '3025002-FLG-307',
    '',
    '1'
  ]]);
});
