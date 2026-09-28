import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Button, Input, Progress, Space, Typography, message } from 'antd';
import { LoadingOutlined, TableOutlined } from '@ant-design/icons';
import ocrService from '../../services/ocrService';

const { Text } = Typography;

const getPdfFileName = (pdfPath, pdfFile) => (
  pdfFile?.name || (typeof pdfPath === 'string' ? pdfPath.split(/[/\\]/).pop() : '') || ''
);

const parsePageSelection = (value, currentPage, totalPages) => {
  const normalizedTotal = Math.max(1, Number(totalPages) || 1);
  const text = String(value || '').trim();

  if (!text) {
    return [Math.min(Math.max(1, Number(currentPage) || 1), normalizedTotal)];
  }

  const pages = new Set();
  const parts = text.split(/[,\s，、]+/).map(item => item.trim()).filter(Boolean);

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*[-~至]\s*(\d+)$/);
    if (rangeMatch) {
      const start = Math.max(1, Math.min(normalizedTotal, Number(rangeMatch[1])));
      const end = Math.max(1, Math.min(normalizedTotal, Number(rangeMatch[2])));
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let page = from; page <= to; page += 1) {
        pages.add(page);
      }
      continue;
    }

    const page = Number(part);
    if (Number.isInteger(page) && page >= 1 && page <= normalizedTotal) {
      pages.add(page);
    }
  }

  return [...pages].sort((a, b) => a - b);
};

export const MaterialRecognitionPanel = ({
  visible,
  pdfPath,
  pdfFile,
  totalPages,
  currentPage,
  materialAreaTemplate,
  pipelineAreaTemplate,
  materialSplitLines = [],
  onClose
}) => {
  const [pageSelection, setPageSelection] = useState('');
  const [recognizing, setRecognizing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, step: '' });

  const targetPages = useMemo(
    () => parsePageSelection(pageSelection, currentPage, totalPages),
    [pageSelection, currentPage, totalPages]
  );

  const pageDescription = pageSelection.trim()
    ? `将识别 ${targetPages.length} 页`
    : `未填写页码时默认识别当前第 ${currentPage || 1} 页`;

  const handleRecognize = useCallback(async () => {
    if (!pdfPath && !pdfFile) {
      message.error('PDF文件未提供');
      return;
    }

    if (!materialAreaTemplate) {
      message.warning('请先框选材料表区域');
      return;
    }

    const pages = parsePageSelection(pageSelection, currentPage, totalPages);
    if (pages.length === 0) {
      message.warning('页码范围无效，请重新输入');
      return;
    }

    setRecognizing(true);
    setProgress({ current: 0, total: pages.length, step: '准备识别材料表' });

    try {
      const pdfSource = pdfFile || pdfPath;
      const pdfFileName = getPdfFileName(pdfPath, pdfFile);
      const materialTemplate = {
        materialArea: materialAreaTemplate,
        ...(pipelineAreaTemplate ? { pipelineArea: pipelineAreaTemplate } : {}),
        columns: materialSplitLines || [],
        dividers: materialSplitLines || []
      };

      const pageResults = {};
      pages.forEach(pageNum => {
        pageResults[pageNum] = {
          materials: [],
          rawLogicalRows: [],
          sourcePage: pageNum,
          fromMinerU: true,
          materialBatchRange: { startPage: pages[0], endPage: pages[pages.length - 1], pages }
        };
      });

      const extractCell = (rowObj, idx) => {
        const key = `column${idx}`;
        const cell = rowObj?.[key];
        if (cell && typeof cell === 'object') return cell.text || '';
        return cell || '';
      };

      const isSixColumnMaterialRow = (row) => (
        Array.isArray(row) &&
        row.length >= 6 &&
        /管|弯头|弯管|三通|法兰|垫片|阀|螺栓|支架|PIPE|ELBOW|TEE|FLANGE|GASKET|VALVE|BOLT|SUPPORT/i.test(String(row[4] || ''))
      );

      const buildMaterialFromRawRow = (row, rowIndex, pageNum) => {
        const sixColumnLayout = isSixColumnMaterialRow(row);
        return {
          materialId: row?.[0],
          description: sixColumnLayout ? row?.[4] : row?.[1],
          specification: row?.[2],
          materialCode: sixColumnLayout ? row?.[1] : row?.[3],
          quantity: sixColumnLayout ? row?.[5] : row?.[4],
          pipelineNumber: sixColumnLayout ? (row?.[6] || '') : (row?.[5] || row?.[7] || ''),
          drawingNumber: sixColumnLayout ? (row?.[7] || '') : (row?.[6] || row?.[8] || ''),
          ocrPage: sixColumnLayout ? (row?.[8] || '') : (row?.[7] || row?.[9] || ''),
          calculatedPage: pageNum,
          sourcePage: pageNum,
          key: `${pageNum}-${rowIndex}-${row?.[0] || rowIndex + 1}`,
          rawLogicalRow: row
        };
      };

      const applyMinerUResultToPage = (result, targetPage) => {
        const pageObjects = Array.isArray(result?.logical_rows) ? result.logical_rows : [];
        const pageResult = pageResults[targetPage] || {
          materials: [],
          rawLogicalRows: [],
          sourcePage: targetPage,
          fromMinerU: true,
          materialBatchRange: { startPage: pages[0], endPage: pages[pages.length - 1], pages }
        };

        if (
          pageObjects.length > 0 &&
          !Array.isArray(pageObjects[0]) &&
          (pageObjects[0]?.material || pageObjects[0]?.pipeline || pageObjects[0]?.pageNumber)
        ) {
          const pageObj = pageObjects[0];
          const pipelineText = pageObj?.pipeline?.text || '';
          const drawingText = pageObj?.drawingNumber?.text || '';
          const pageText = pageObj?.pageNumber?.text || '';
          const materials = Array.isArray(pageObj?.material) ? pageObj.material : [];

          pageResult.pipelineNumber = pipelineText;
          pageResult.drawingNumber = drawingText;
          pageResult.pageNumber = pageText;
          pageResult.materials = materials.map((rowObj, rowIndex) => {
            const maxColumn = Math.max(
              5,
              ...Object.keys(rowObj || {})
                .map(key => /^column(\d+)$/.exec(key))
                .filter(Boolean)
                .map(match => Number(match[1]))
            );
            const rawRow = Array.from({ length: maxColumn }, (_, index) => extractCell(rowObj, index + 1));
            const mapped = buildMaterialFromRawRow(rawRow, rowIndex, targetPage);
            return {
              ...mapped,
              pipelineNumber: pipelineText,
              drawingNumber: drawingText,
              ocrPage: pageText,
              calculatedPage: targetPage,
              sourcePage: targetPage,
              key: `${targetPage}-${rowIndex}-${rawRow[0] || rowIndex + 1}`,
              rawMaterial: rowObj,
              rawLogicalRow: rawRow
            };
          });
          pageResult.rawLogicalRows = pageResult.materials.map(item => item.rawLogicalRow);
          pageResults[targetPage] = pageResult;
          return;
        }

        const rows = pageObjects.filter(Array.isArray);
        pageResult.rawLogicalRows = rows;
        pageResult.materials = rows.map((row, rowIndex) => buildMaterialFromRawRow(row, rowIndex, targetPage));
        pageResult.pipelineNumber = pageResult.materials.find(item => item.pipelineNumber)?.pipelineNumber || '';
        pageResults[targetPage] = pageResult;
      };

      for (let index = 0; index < pages.length; index += 1) {
        const pageNum = pages[index];
        setProgress({
          current: index,
          total: pages.length,
          step: `材料表识别中：第 ${pageNum} 页`
        });

        const result = await ocrService.runBatchOCRMinerU({
          pdfFile: pdfSource,
          pdfFileName,
          template: materialTemplate,
          pages: { type: 'custom', pages: [pageNum] },
          _suppressMinerUExcelDownload: true
        }, (progressData) => {
          const percent = Math.max(0, Math.min(100, Number(progressData?.progress) || 0));
          setProgress({
            current: index + percent / 100,
            total: pages.length,
            step: progressData?.status || `材料表识别中：第 ${pageNum} 页`
          });
        });

        applyMinerUResultToPage(result, pageNum);
      }

      const totalRows = Object.values(pageResults).reduce((sum, pageData) => {
        const count = Array.isArray(pageData?.materials) && pageData.materials.length > 0
          ? pageData.materials.length
          : Array.isArray(pageData?.rawLogicalRows) ? pageData.rawLogicalRows.length : 0;
        return sum + count;
      }, 0);

      window.dispatchEvent(new CustomEvent('ocr-batch-completed', {
        detail: {
          success: true,
          mode: 'material',
          fileName: pdfFileName,
          startPage: pages[0],
          endPage: pages[pages.length - 1],
          pages,
          totalRows,
          pageResults
        }
      }));

      setProgress({ current: pages.length, total: pages.length, step: '材料表识别完成' });
      message.success(`材料表识别完成，共 ${totalRows} 行数据`);
    } catch (error) {
      console.error('材料表识别失败', error);
      message.error(`材料表识别失败：${error.message}`);
    } finally {
      setRecognizing(false);
    }
  }, [
    pdfPath,
    pdfFile,
    pageSelection,
    currentPage,
    totalPages,
    materialAreaTemplate,
    materialSplitLines,
    pipelineAreaTemplate
  ]);

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="材料表识别"
        description="默认只识别当前页。需要识别多页时，可输入页码或页码范围，例如 3、3-5、1,3,8-10。"
      />

      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text strong>页码范围</Text>
        <Input
          placeholder={`默认当前页：${currentPage || 1}`}
          value={pageSelection}
          onChange={event => setPageSelection(event.target.value)}
          disabled={recognizing}
        />
        <Text type={targetPages.length > 0 ? 'secondary' : 'danger'}>
          {targetPages.length > 0 ? pageDescription : '未解析到有效页码'}
        </Text>
      </Space>

      <Progress
        percent={progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}
        status={recognizing ? 'active' : progress.current >= progress.total && progress.total > 0 ? 'success' : 'normal'}
      />
      <Text type="secondary">{progress.step || '等待识别'}</Text>

      <Space>
        <Button
          type="primary"
          icon={recognizing ? <LoadingOutlined /> : <TableOutlined />}
          loading={recognizing}
          onClick={handleRecognize}
        >
          开始识别
        </Button>
        <Button onClick={onClose} disabled={recognizing}>
          关闭
        </Button>
      </Space>
    </Space>
  );
};

export default MaterialRecognitionPanel;
