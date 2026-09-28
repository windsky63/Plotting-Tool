import JSZip from 'jszip';

const TEMPLATE_URL = `${process.env.PUBLIC_URL || ''}/templates/weld-table-template.xlsx`;
const XML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const asText = (value) => value === undefined || value === null ? '' : String(value).trim();

const pick = (sources, keys, fallback = '') => {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return fallback;
};

const columnName = (index) => {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
};

const parseXml = (xml, fileName) => {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) {
    throw new Error(`无法解析 Excel 模板文件：${fileName}`);
  }
  return document;
};

const firstByLocalName = (parent, name) =>
  Array.from(parent.getElementsByTagNameNS('*', name))[0] || null;

const directChildren = (parent, name) =>
  Array.from(parent.childNodes).filter(node => node.nodeType === 1 && node.localName === name);

const writeInlineValue = (document, cell, value) => {
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.removeAttribute('t');
  const text = asText(value);
  if (!text) return;

  cell.setAttribute('t', 'inlineStr');
  const inlineString = document.createElementNS(XML_NS, 'is');
  const textNode = document.createElementNS(XML_NS, 't');
  if (/^\s|\s$/.test(String(value))) textNode.setAttribute('xml:space', 'preserve');
  textNode.textContent = String(value);
  inlineString.appendChild(textNode);
  cell.appendChild(inlineString);
};

const writeFormula = (document, cell, formula) => {
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  cell.removeAttribute('t');
  const formulaNode = document.createElementNS(XML_NS, 'f');
  formulaNode.textContent = formula;
  cell.appendChild(formulaNode);
};

const createRowFromTemplate = (document, templateRow, rowNumber, values, formulaColumns = {}) => {
  const row = templateRow.cloneNode(true);
  row.setAttribute('r', String(rowNumber));
  row.setAttribute('spans', `1:${values.length}`);

  const cells = directChildren(row, 'c');
  for (let index = 0; index < values.length; index += 1) {
    let cell = cells[index];
    if (!cell) {
      cell = document.createElementNS(XML_NS, 'c');
      row.appendChild(cell);
    }
    cell.setAttribute('r', `${columnName(index)}${rowNumber}`);
    if (formulaColumns[index]) {
      writeFormula(document, cell, formulaColumns[index](rowNumber));
    } else {
      writeInlineValue(document, cell, values[index]);
    }
  }
  cells.slice(values.length).forEach(cell => cell.remove());
  return row;
};

const replaceSheetRows = (document, {
  headerRowCount,
  styleSourceRowNumber,
  rows,
  startColumn,
  endColumn,
  formulaColumns = {}
}) => {
  const sheetData = firstByLocalName(document, 'sheetData');
  if (!sheetData) throw new Error('Excel 模板缺少 sheetData');

  const existingRows = directChildren(sheetData, 'row');
  const styleSource = existingRows.find(row => Number(row.getAttribute('r')) === styleSourceRowNumber)
    || existingRows[headerRowCount]
    || existingRows[existingRows.length - 1];
  if (!styleSource) throw new Error('Excel 模板缺少数据行样式');
  const styleTemplate = styleSource.cloneNode(true);

  existingRows
    .filter(row => Number(row.getAttribute('r')) > headerRowCount)
    .forEach(row => row.remove());

  rows.forEach((values, index) => {
    const rowNumber = headerRowCount + index + 1;
    sheetData.appendChild(createRowFromTemplate(
      document,
      styleTemplate,
      rowNumber,
      values,
      formulaColumns
    ));
  });

  const lastRow = Math.max(headerRowCount, headerRowCount + rows.length);
  const dimension = firstByLocalName(document, 'dimension');
  if (dimension) dimension.setAttribute('ref', `${startColumn}1:${endColumn}${lastRow}`);
  const autoFilter = firstByLocalName(document, 'autoFilter');
  if (autoFilter) autoFilter.setAttribute('ref', `${startColumn}1:${endColumn}${lastRow}`);
  return lastRow;
};

const materialSources = (material) => [
  material,
  material?.rawMaterial,
  material?.rawLogicalRow
];

const getMaterial = (annotation, index) => {
  const materials = Array.isArray(annotation?.materialBindings) && annotation.materialBindings.length
    ? annotation.materialBindings
    : (annotation?.materialBinding ? [annotation.materialBinding] : []);
  return materials[index] || {};
};

const normalizeDiameter = (materials) => {
  const candidates = materials
    .map(material => asText(pick(materialSources(material), ['diameter', '管径', 'ND', 'specification', '规格'])))
    .filter(Boolean);
  const direct = candidates.find(value => !/[xX×*]/.test(value));
  return direct || asText(candidates[0]).split(/[xX×*]/)[0].trim();
};

const getAttributes = (annotation) => {
  const attributes = annotation?.attributeValues || annotation?.attributes;
  return attributes && !Array.isArray(attributes) && typeof attributes === 'object' ? attributes : {};
};

const getWeldLocation = (annotation) => {
  const shape = annotation?.borderShape;
  if (shape === 'circle' || shape === 'split-circle' || shape === 'shop-weld') return 'S';
  if (shape === 'field-weld') return 'FD';
  if (shape === 'diamond') return 'F';
  return '';
};

const extractNumericSpecification = (value) => {
  const text = asText(value);
  const match = text.match(/\d+(?:\.\d+)?(?:\s*(?:\/|×|x|X|\*)\s*\d+(?:\.\d+)?)*/);
  return match ? match[0].replace(/\s+/g, '') : '';
};

const splitRuleNumber = (value) => {
  const text = asText(value);
  const numberMatch = text.match(/\d+(?:\.\d+)?/);
  const weldNumber = numberMatch ? numberMatch[0] : text;
  const weldType = numberMatch
    ? text
      .replace(numberMatch[0], '')
      .replace(/^[\s._-]+|[\s._-]+$/g, '')
    : '';
  return { weldNumber, weldType };
};

const extractPageSequence = (value) => {
  const text = asText(value);
  if (!text) return '';
  const chinesePage = text.match(/第\s*(\d+(?:\.\d+)?)\s*页/);
  if (chinesePage) return chinesePage[1];
  const number = text.match(/\d+(?:\.\d+)?/);
  return number ? number[0] : '';
};

const formatSingleLineSuffix = (value) => {
  const text = asText(value);
  return /^\d+$/.test(text) ? text.padStart(2, '0') : text;
};

const getAnnotationExportContext = (annotation) => {
  const materialA = getMaterial(annotation, 0);
  const materialB = getMaterial(annotation, 1);
  const allSources = [
    annotation,
    annotation?.weldData,
    getAttributes(annotation),
    ...materialSources(materialA),
    ...materialSources(materialB)
  ];
  const pipelineNumber = asText(pick(allSources, ['pipelineNumber', '管线号']));
  const pageIdentity = asText(pick(
    allSources,
    ['drawingPageNumber', '图纸页码', 'calculatedPage', '计算页码', 'page', 'drawingNumber', '图号']
  ));
  return { materialA, materialB, allSources, pipelineNumber, pageIdentity };
};

const buildImportRows = (annotations, pages = []) => {
  const splitCircleAnnotations = annotations
    .map((annotation, originalIndex) => ({ annotation, originalIndex }))
    .filter(item => item.annotation?.borderShape === 'split-circle');
  const annotationsByPage = new Map();
  splitCircleAnnotations.forEach((item) => {
    const pdfPage = Number(item.annotation?.page) || 1;
    if (!annotationsByPage.has(pdfPage)) annotationsByPage.set(pdfPage, []);
    annotationsByPage.get(pdfPage).push(item);
  });
  annotationsByPage.forEach(items => items.sort((left, right) => {
    const leftNumber = Number(splitRuleNumber(left.annotation?.text).weldNumber);
    const rightNumber = Number(splitRuleNumber(right.annotation?.text).weldNumber);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
    return left.originalIndex - right.originalIndex;
  }));

  const orderedPages = pages.length > 0
    ? [...pages].sort((left, right) => Number(left.pdfPage) - Number(right.pdfPage))
    : Array.from(annotationsByPage.keys())
      .sort((left, right) => left - right)
      .map(pdfPage => ({ pdfPage }));
  const pipelineDrawingCount = new Map();
  let nextDrawingSequence = 1;
  const result = [];

  orderedPages.forEach((page) => {
    const pdfPage = Number(page.pdfPage) || 1;
    const pageAnnotations = annotationsByPage.get(pdfPage) || [];
    const firstContext = pageAnnotations.length
      ? getAnnotationExportContext(pageAnnotations[0].annotation)
      : null;
    const pipelineNumber = asText(page.pipelineNumber) || firstContext?.pipelineNumber || '';
    const pagePipeClass = asText(page.pipeClass || page.pipelineClass);
    const fallbackPipelineDrawingIndex = (pipelineDrawingCount.get(pipelineNumber) || 0) + 1;
    pipelineDrawingCount.set(pipelineNumber, fallbackPipelineDrawingIndex);
    const recognizedPageSequence = extractPageSequence(page.pageNumber);
    const lineSuffix = formatSingleLineSuffix(
      recognizedPageSequence || fallbackPipelineDrawingIndex
    );
    const singleLineNumber = pipelineNumber && lineSuffix
      ? `${pipelineNumber}-${lineSuffix}`
      : '';
    const drawingSequence = nextDrawingSequence;
    nextDrawingSequence += 1;

    if (pageAnnotations.length === 0) {
      result.push([
        singleLineNumber, pipelineNumber, drawingSequence,
        '', pagePipeClass, '', '', '', '', '', '-', '', '', '', 'TIN', '', ''
      ]);
      return;
    }

    pageAnnotations.forEach(({ annotation }) => {
      const { materialA, materialB, allSources } = getAnnotationExportContext(annotation);
      const splitBottom = splitRuleNumber(annotation?.text);
      result.push([
        singleLineNumber,
        pipelineNumber,
        drawingSequence,
        splitBottom.weldNumber,
        pick(allSources, ['pipeClass', 'pipelineClass', '管道等级', '等级'], pagePipeClass),
        extractNumericSpecification(annotation?.topText),
        annotation?.jointTypeText || pick(allSources, ['jointType', '接头形式', '焊缝类型']),
        getWeldLocation(annotation),
        pick(allSources, ['weldingProcess', '焊接工艺', '焊接方法']),
        pick(allSources, ['pressureTestPackage', 'testPackage', '试压包号']),
        splitBottom.weldType,
        pick(materialSources(materialA), ['componentName', '管件名称', 'type', '类型', 'description', '材料描述']),
        pick(materialSources(materialB), ['componentName', '管件名称', 'type', '类型', 'description', '材料描述']),
        pick(allSources, ['specLength', '规格长度']),
        pick(allSources, ['TIN', 'tin'], 'TIN'),
        pick(allSources, ['schedule', 'scheduleNumber', '壁厚号']),
        pick(allSources, ['material', '材质'])
      ]);
    });
  });
  return result;
};

const buildDirectoryRows = (annotations, projectName) => {
  const seen = new Set();
  const sequenceByDrawing = new Map();
  const result = [];

  annotations.forEach((annotation) => {
    const materialA = getMaterial(annotation, 0);
    const sources = [
      annotation,
      annotation?.weldData,
      getAttributes(annotation),
      ...materialSources(materialA)
    ];
    const pipeline = asText(pick(sources, ['pipelineNumber', '管线号']));
    const drawing = asText(pick(sources, ['drawingNumber', '图号', 'singleLineNumber', '单线图号']));
    const page = asText(pick(sources, ['drawingPageNumber', '图纸页码', 'calculatedPage', '计算页码', 'page']));
    const uniqueKey = [drawing, pipeline, page].join('|');
    if (seen.has(uniqueKey)) return;
    seen.add(uniqueKey);

    const sequenceKey = drawing || pipeline || 'default';
    const sequence = (sequenceByDrawing.get(sequenceKey) || 0) + 1;
    sequenceByDrawing.set(sequenceKey, sequence);
    result.push([
      '', // B列由公式生成：单位工程 + 图纸页码
      pick(sources, ['contract', '合同']),
      pick(sources, ['unitProject', '单位工程'], projectName),
      sequence,
      pick(sources, ['changeType']) === 'NEW' ? '√' : '',
      pick(sources, ['changeType']) === 'REV' ? '√' : '',
      pick(sources, ['changeType']) === 'DEL' ? '√' : '',
      pick(sources, ['area', '区域']),
      pipeline,
      pick(sources, ['pipeClass', 'pipelineClass', '管道等级', '等级']),
      drawing,
      pick(sources, ['revision', '版次']),
      page,
      pick(sources, ['isoDrawingNumber', 'ISO图纸编号', 'singleLineNumber', '单线图号']),
      pick(sources, ['pressureTestPackage', 'testPackage', '试压包号']),
      pick(sources, ['secondaryCode', '二级编号']),
      pick(sources, ['grade', '等级'])
    ]);
  });
  return result;
};

const updateDefinedRanges = (workbookDocument, importLastRow, directoryLastRow) => {
  Array.from(workbookDocument.getElementsByTagNameNS('*', 'definedName')).forEach(node => {
    const value = node.textContent || '';
    if (value.includes('导入数据!')) node.textContent = `导入数据!$A$1:$Q$${importLastRow}`;
    if (value.includes('图纸目录!')) node.textContent = `图纸目录!$B$2:$R$${directoryLastRow}`;
  });
  let calcPr = firstByLocalName(workbookDocument, 'calcPr');
  if (!calcPr) {
    calcPr = workbookDocument.createElementNS(XML_NS, 'calcPr');
    workbookDocument.documentElement.appendChild(calcPr);
  }
  calcPr.setAttribute('calcMode', 'auto');
  calcPr.setAttribute('fullCalcOnLoad', '1');
  calcPr.setAttribute('forceFullCalc', '1');
};

export const exportWeldTableFromTemplate = async ({
  annotations,
  pages = [],
  fileName,
  projectName = ''
}) => {
  const response = await fetch(TEMPLATE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`焊口表模板加载失败（HTTP ${response.status}）`);

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const importSheetPath = 'xl/worksheets/sheet1.xml';
  const directorySheetPath = 'xl/worksheets/sheet2.xml';
  const workbookPath = 'xl/workbook.xml';
  const [importXml, directoryXml, workbookXml] = await Promise.all([
    zip.file(importSheetPath)?.async('string'),
    zip.file(directorySheetPath)?.async('string'),
    zip.file(workbookPath)?.async('string')
  ]);
  if (!importXml || !directoryXml || !workbookXml) {
    throw new Error('焊口表模板结构不完整');
  }

  const importDocument = parseXml(importXml, importSheetPath);
  const directoryDocument = parseXml(directoryXml, directorySheetPath);
  const workbookDocument = parseXml(workbookXml, workbookPath);
  const importRows = buildImportRows(annotations, pages);
  const splitCircleAnnotations = annotations.filter(
    annotation => annotation?.borderShape === 'split-circle'
  );
  const directoryRows = buildDirectoryRows(splitCircleAnnotations, projectName);

  const importLastRow = replaceSheetRows(importDocument, {
    headerRowCount: 1,
    styleSourceRowNumber: 4,
    rows: importRows,
    startColumn: 'A',
    endColumn: 'Q'
  });
  const directoryLastRow = replaceSheetRows(directoryDocument, {
    headerRowCount: 2,
    styleSourceRowNumber: 3,
    rows: directoryRows,
    startColumn: 'B',
    endColumn: 'R',
    formulaColumns: {
      0: rowNumber => `D${rowNumber}&N${rowNumber}`
    }
  });
  updateDefinedRanges(workbookDocument, importLastRow, directoryLastRow);

  const serializer = new XMLSerializer();
  zip.file(importSheetPath, serializer.serializeToString(importDocument));
  zip.file(directorySheetPath, serializer.serializeToString(directoryDocument));
  zip.file(workbookPath, serializer.serializeToString(workbookDocument));

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return {
    weldCount: splitCircleAnnotations.length,
    importRowCount: importRows.length,
    drawingCount: directoryRows.length
  };
};
