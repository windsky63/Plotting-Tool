import * as XLSX from 'xlsx';

const cellText = (value) => String(value ?? '').normalize('NFKC').trim();

const headerKey = (value) => cellText(value)
  .toUpperCase()
  .replace(/[\s._()（）/\\-]+/g, '');

const isPartNumber = (value) => /^\d+(?:\.\d+)?$/.test(cellText(value));

const isQuantity = (value) => /^\d+(?:\.\d+)?(?:\s*(?:M|PCS?|EA|SET|件|个))?$/i.test(cellText(value));

const findHeaderIndex = (headers, aliases) => headers.findIndex((header) => (
  aliases.some(alias => header.includes(alias))
));

/**
 * Read MinerU's Excel export and return a stable material layout:
 * PART NO. | ITEM CODE | SIZE | ACC | DESCRIPTION | QTY |
 * pipeline | drawing | page.
 *
 * The remote logical_rows flattener can drop QTY when ACC is empty, although
 * the independently generated Excel export still contains the quantity.
 */
export const parseMineruExcelLogicalRows = (arrayBuffer) => {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) return [];

  const table = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false
  });
  const headerRowIndex = table.findIndex((row) => {
    const keys = (row || []).map(headerKey);
    return keys.some(key => key.includes('PARTNO')) &&
      keys.some(key => key.includes('ITEMCODE')) &&
      keys.some(key => key === 'QTY' || key.includes('QUANTITY'));
  });
  if (headerRowIndex < 0) return [];

  const headerRow = table[headerRowIndex].map(headerKey);
  const partIndex = findHeaderIndex(headerRow, ['PARTNO']);
  const itemIndex = findHeaderIndex(headerRow, ['ITEMCODE']);
  const sizeIndex = findHeaderIndex(headerRow, ['SIZEMM', 'SIZE', 'DN', 'ND']);
  const accIndex = findHeaderIndex(headerRow, ['ACC']);
  const descriptionIndex = findHeaderIndex(headerRow, ['MATERIALDESCRIPTION', 'DESCRIPTION']);
  const quantityIndex = findHeaderIndex(headerRow, ['QTY', 'QUANTITY']);
  const pipelineIndex = findHeaderIndex(headerRow, ['管线号', 'PIPELINENO', 'PIPELINE']);
  const drawingIndex = findHeaderIndex(headerRow, ['图号', 'DRAWINGNO', 'DRAWING']);
  const pageIndex = findHeaderIndex(headerRow, ['页码', '页', 'PAGE']);
  const metadataIndexes = [pipelineIndex, drawingIndex, pageIndex].filter(index => index >= 0);
  const materialEnd = metadataIndexes.length > 0
    ? Math.min(...metadataIndexes)
    : headerRow.length;

  const rows = [];
  for (const sourceRow of table.slice(headerRowIndex + 1)) {
    const row = (sourceRow || []).map(cellText);
    const partNumber = row[partIndex] || '';
    if (!isPartNumber(partNumber)) continue;

    const searchStart = Math.max(0, Math.min(
      accIndex >= 0 ? accIndex : 3,
      descriptionIndex >= 0 ? descriptionIndex : 4
    ));
    const materialCells = [];
    for (let index = searchStart; index < materialEnd; index += 1) {
      if (row[index]) materialCells.push({ index, value: row[index] });
    }

    const descriptionCell = materialCells
      .filter(cell => !isQuantity(cell.value))
      .sort((left, right) => right.value.length - left.value.length)[0];
    const quantityCell = materialCells.find(cell => (
      isQuantity(cell.value) &&
      (!descriptionCell || cell.index > descriptionCell.index)
    ));
    const description = descriptionCell?.value ||
      (descriptionIndex >= 0 ? row[descriptionIndex] : '');
    const quantity = quantityCell?.value ||
      (quantityIndex >= 0 ? row[quantityIndex] : '');
    const acc = (
      accIndex >= 0 &&
      accIndex !== descriptionCell?.index &&
      accIndex !== quantityCell?.index
    ) ? row[accIndex] : '';

    rows.push([
      partNumber,
      itemIndex >= 0 ? row[itemIndex] : '',
      sizeIndex >= 0 ? row[sizeIndex] : '',
      acc,
      description,
      quantity,
      pipelineIndex >= 0 ? row[pipelineIndex] : '',
      drawingIndex >= 0 ? row[drawingIndex] : '',
      pageIndex >= 0 ? row[pageIndex] : ''
    ]);
  }

  return rows.some(row => row[5]) ? rows : [];
};
