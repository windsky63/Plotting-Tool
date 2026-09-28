/**
 * 文字检测结果导出工具
 * 用于导出OCR文字识别的检测框位置信息
 */

import { message } from 'antd';

/**
 * 导出文字检测结果为JSON格式
 * @param {Object} textDetections - 文字检测结果 {pageNum: {detections, page_info, pipelineNumber, ...}}
 * @param {string} pdfFileName - PDF文件名
 */
export function exportTextDetectionsJSON(textDetections, pdfFileName = 'document') {
  try {
    if (!textDetections || Object.keys(textDetections).length === 0) {
      message.warning('没有可导出的文字识别数据');
      return;
    }

    // 构建导出数据
    const exportData = {
      metadata: {
        pdfFileName: pdfFileName,
        exportTime: new Date().toISOString(),
        totalPages: Object.keys(textDetections).length,
        totalDetections: Object.values(textDetections).reduce(
          (sum, page) => sum + (page.detections?.length || 0), 
          0
        )
      },
      pages: {}
    };

    // 遍历每一页
    Object.entries(textDetections).forEach(([pageNum, pageData]) => {
      const detections = pageData.detections || [];
      const pageInfo = pageData.page_info || {};

      exportData.pages[pageNum] = {
        pageNumber: parseInt(pageNum),
        pageWidth: pageInfo.page_width || 0,
        pageHeight: pageInfo.page_height || 0,
        coordinateFormat: pageInfo.coordinate_format || 'relative',
        detectionCount: detections.length,
        pipelineNumber: pageData.pipelineNumber || '',
        pipelineStatus: pageData.pipelineStatus || 'unresolved',
        pipelineConfidence: pageData.pipelineConfidence || 0,
        pipelineSource: pageData.pipelineSource || '',
        pipelineEngine: pageData.pipelineEngine || 'paddleocr',
        pipelineFallbackUsed: !!pageData.pipelineFallbackUsed,
        pipelineCandidateCount: pageData.pipelineCandidates?.length || 0,
        pipelineCandidates: (pageData.pipelineCandidates || []).map((candidate, index) => ({
          index: index + 1,
          text: candidate.text || '',
          normalizedText: candidate.normalizedText || '',
          score: candidate.score || 0,
          confidence: candidate.confidence || 0
        })),
        detections: detections.map((detection, index) => ({
          index: index + 1,
          text: detection.text || '',
          confidence: detection.score || detection.confidence || 0,
          boundingBox: detection.box || [],
          coordinates: detection.coordinates || {},
          area: calculateDetectionArea(detection.box),
          center: calculateDetectionCenter(detection.box)
        }))
      };
    });

    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const fileName = `text_detections_${pdfFileName}_${timestamp}.json`;

    // 下载文件
    downloadJSON(exportData, fileName);
    
    message.success(`导出成功: ${fileName}`);
    console.log('📄 文字检测结果已导出:', exportData);
    
    return exportData;
  } catch (error) {
    console.error('导出文字检测结果失败:', error);
    message.error(`导出失败: ${error.message}`);
    throw error;
  }
}

/**
 * 导出文字检测结果为CSV格式
 * @param {Object} textDetections - 文字检测结果
 * @param {string} pdfFileName - PDF文件名
 */
export function exportTextDetectionsCSV(textDetections, pdfFileName = 'document') {
  try {
    if (!textDetections || Object.keys(textDetections).length === 0) {
      message.warning('没有可导出的文字识别数据');
      return;
    }

    // CSV表头
    const headers = [
      '页码',
      '管线号',
      '管线状态',
      '管线置信度',
      '管线候选数',
      '管线来源',
      '管线引擎',
      '是否回退',
      '序号',
      '文字内容',
      '置信度',
      '中心点X',
      '中心点Y',
      '左上角X',
      '左上角Y',
      '右上角X',
      '右上角Y',
      '右下角X',
      '右下角Y',
      '左下角X',
      '左下角Y',
      '面积',
      '页面宽度',
      '页面高度',
      '坐标格式'
    ];

    const rows = [headers];

    // 遍历每一页
    Object.entries(textDetections).forEach(([pageNum, pageData]) => {
      const detections = pageData.detections || [];
      const pageInfo = pageData.page_info || {};
      const pageWidth = pageInfo.page_width || 0;
      const pageHeight = pageInfo.page_height || 0;
      const coordinateFormat = pageInfo.coordinate_format || 'relative';
      const pipelineNumber = pageData.pipelineNumber || '';
      const pipelineStatus = pageData.pipelineStatus || 'unresolved';
      const pipelineConfidence = pageData.pipelineConfidence || 0;
      const pipelineCandidateCount = pageData.pipelineCandidates?.length || 0;
      const pipelineSource = pageData.pipelineSource || '';
      const pipelineEngine = pageData.pipelineEngine || 'paddleocr';
      const pipelineFallbackUsed = pageData.pipelineFallbackUsed ? '是' : '否';

      if (detections.length === 0) {
        rows.push([
          pageNum,
          `"${pipelineNumber.replace(/"/g, '""')}"`,
          pipelineStatus,
          pipelineConfidence.toFixed(4),
          pipelineCandidateCount,
          `"${pipelineSource.replace(/"/g, '""')}"`,
          pipelineEngine,
          pipelineFallbackUsed,
          '',
          '""',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          pageWidth.toFixed(2),
          pageHeight.toFixed(2),
          coordinateFormat
        ]);
        return;
      }

      detections.forEach((detection, index) => {
        const box = detection.box || [[0,0], [0,0], [0,0], [0,0]];
        const center = calculateDetectionCenter(box);
        const area = calculateDetectionArea(box);
        const text = (detection.text || '').replace(/"/g, '""'); // 转义双引号

        rows.push([
          pageNum,
          `"${pipelineNumber.replace(/"/g, '""')}"`,
          pipelineStatus,
          pipelineConfidence.toFixed(4),
          pipelineCandidateCount,
          `"${pipelineSource.replace(/"/g, '""')}"`,
          pipelineEngine,
          pipelineFallbackUsed,
          index + 1,
          `"${text}"`,
          (detection.score || detection.confidence || 0).toFixed(4),
          center.x.toFixed(4),
          center.y.toFixed(4),
          box[0][0].toFixed(4),
          box[0][1].toFixed(4),
          box[1][0].toFixed(4),
          box[1][1].toFixed(4),
          box[2][0].toFixed(4),
          box[2][1].toFixed(4),
          box[3][0].toFixed(4),
          box[3][1].toFixed(4),
          area.toFixed(4),
          pageWidth.toFixed(2),
          pageHeight.toFixed(2),
          coordinateFormat
        ]);
      });
    });

    // 转换为CSV字符串
    const csvContent = rows.map(row => row.join(',')).join('\n');

    // 生成文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const fileName = `text_detections_${pdfFileName}_${timestamp}.csv`;

    // 下载文件
    downloadCSV(csvContent, fileName);
    
    const totalDetections = Object.values(textDetections).reduce(
      (sum, page) => sum + (page.detections?.length || 0), 
      0
    );
    message.success(`导出成功: ${fileName} (${totalDetections}个检测框)`);
    
    return csvContent;
  } catch (error) {
    console.error('导出文字检测结果失败:', error);
    message.error(`导出失败: ${error.message}`);
    throw error;
  }
}

/**
 * 导出当前页的文字检测结果
 * @param {Object} pageData - 当前页的检测结果对象
 * @param {number} currentPage - 当前页码
 * @param {string} format - 导出格式 ('json' 或 'csv')
 * @param {string} pdfFileName - PDF文件名
 */
export function exportCurrentPageDetections(pageData, currentPage, format = 'json', pdfFileName = 'document') {
  const textDetections = {
    [currentPage]: pageData || {}
  };

  if (format === 'csv') {
    return exportTextDetectionsCSV(textDetections, pdfFileName);
  } else {
    return exportTextDetectionsJSON(textDetections, pdfFileName);
  }
}

/**
 * 计算检测框的中心点
 * @param {Array} box - 检测框坐标 [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
 * @returns {Object} - 中心点坐标 {x, y}
 */
function calculateDetectionCenter(box) {
  if (!box || box.length !== 4) {
    return { x: 0, y: 0 };
  }

  const xSum = box.reduce((sum, point) => sum + point[0], 0);
  const ySum = box.reduce((sum, point) => sum + point[1], 0);

  return {
    x: xSum / 4,
    y: ySum / 4
  };
}

/**
 * 计算检测框的面积
 * @param {Array} box - 检测框坐标 [[x1,y1], [x2,y2], [x3,y3], [x4,y4]]
 * @returns {number} - 面积
 */
function calculateDetectionArea(box) {
  if (!box || box.length !== 4) {
    return 0;
  }

  // 使用鞋带公式计算四边形面积
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += box[i][0] * box[j][1];
    area -= box[j][0] * box[i][1];
  }

  return Math.abs(area / 2);
}

/**
 * 下载JSON文件
 * @param {Object} data - 数据对象
 * @param {string} filename - 文件名
 */
function downloadJSON(data, filename) {
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  URL.revokeObjectURL(url);
}

/**
 * 下载CSV文件
 * @param {string} csvContent - CSV内容
 * @param {string} filename - 文件名
 */
function downloadCSV(csvContent, filename) {
  // 添加BOM以支持Excel正确显示UTF-8
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  URL.revokeObjectURL(url);
}

/**
 * 获取文字检测统计信息
 * @param {Object} textDetections - 文字检测结果
 * @returns {Object} - 统计信息
 */
export function getTextDetectionStats(textDetections) {
  if (!textDetections || Object.keys(textDetections).length === 0) {
    return {
      totalPages: 0,
      totalDetections: 0,
      avgDetectionsPerPage: 0,
      avgConfidence: 0
    };
  }

  const pages = Object.values(textDetections);
  const totalPages = pages.length;
  const totalDetections = pages.reduce(
    (sum, page) => sum + (page.detections?.length || 0), 
    0
  );

  // 计算平均置信度
  let totalConfidence = 0;
  let detectionCount = 0;
  pages.forEach(page => {
    (page.detections || []).forEach(detection => {
      totalConfidence += detection.score || detection.confidence || 0;
      detectionCount++;
    });
  });

  return {
    totalPages,
    totalDetections,
    avgDetectionsPerPage: totalDetections / totalPages,
    avgConfidence: detectionCount > 0 ? totalConfidence / detectionCount : 0
  };
}

