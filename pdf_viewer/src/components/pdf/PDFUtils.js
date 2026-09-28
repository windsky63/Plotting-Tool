/**
 * PDF工具函数模块
 * 负责处理OCR调用、数据处理、Excel导出等工具函数
 */

import { useCallback } from 'react';
import { message } from 'antd';
import * as XLSX from 'xlsx';
import { OCRUtils } from '../../utils/ocrUtils';

export const usePDFUtils = ({
  // 状态数据
  file,
  currentPage,
  globalPipelineArea,
  globalPipeClassArea,
  globalPageNumberArea,
  globalDrawingNumberArea,
  globalScaffoldArea,
  pageObjectsRef,
  pageRefsRef,
  scale,
  renderMode
}) => {
  
  // 检测运行环境
  const isElectron = useCallback(() => {
    return typeof window !== 'undefined' && !!window.electronAPI;
  }, []);

  // 本地PaddleOCR调用（Electron）
  const callLocalPaddleOCR = useCallback(async (base64Image, options = {}) => {
    // 检查是否在Electron环境中
    if (!isElectron()) {
      throw new Error('OCR功能仅在Electron环境中可用，当前为Web开发环境');
    }
    
    try {
      // 直接使用可用的paddleOCR方法
      const result = await window.electronAPI.paddleOCR(base64Image);
      
      if (!result || result.length === 0) return { text: '', confidence: 0 };
      
      // 处理OCR结果
      const text = Array.isArray(result) ? result.map(r => r.text).join('\n') : result.text || '';
      const confidence = Array.isArray(result) ? 
        (result.reduce((s, r) => s + (r.confidence || 0), 0) / result.length) : 
        (result.confidence || 0);
      
      return { text, confidence };
    } catch (error) {
      console.error('Local OCR failed:', error);
      throw error;
    }
  }, [isElectron]);

  // Web PaddleOCR调用（本地服务）
  const callWebPaddleOCR = useCallback(async (base64Image, options = {}) => {
    try {
      let endpoint = 'http://localhost:8866/predict/ocr_system';
      let requestBody = { images: [base64Image] };
      
      // 根据类型选择不同的端点
      if (options.type === 'table') {
        endpoint = 'http://localhost:8866/predict/ocr_system';
        requestBody = {
          images: [base64Image],
          region: options.region,
          columns: options.columns
        };
      } else if (options.type === 'batch') {
        endpoint = 'http://localhost:8866/predict/ocr_system';
        requestBody = {
          images: [base64Image],
          regions: options.regions
        };
      } else if (options.region) {
        endpoint = 'http://localhost:8866/predict/ocr_system';
        requestBody = {
          images: [base64Image],
          region: options.region
        };
      }
      
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
      
      if (!resp.ok) throw new Error('PaddleOCR服务器不可用');
      const data = await resp.json();
      
      // 处理不同端点的返回格式
      if (options.type === 'table' && data.columns) {
        return {
          text: data.text || '',
          confidence: data.confidence || 0,
          columns: data.columns,
          structured: data.structured
        };
      } else if (options.type === 'batch' && Array.isArray(data.results)) {
        return data.results.map(result => ({
          text: Array.isArray(result) ? result.map(item => item.text).join('\n') : result.text || '',
          confidence: Array.isArray(result) ?
            (result.reduce((s, item) => s + (item.confidence || 0), 0) / result.length * 100) :
            (result.confidence || 0)
        }));
      } else if (data.results && data.results[0]) {
        // 标准OCR结果
        const arr = data.results[0];
        const text = arr.map(item => item.text).join('\n');
        const confidence = arr.length ? (arr.reduce((s, i) => s + (i.confidence || 0), 0) / arr.length * 100) : 0;
        return { text, confidence };
      } else if (data.text !== undefined) {
        // 新格式结果
        return {
          text: data.text,
          confidence: data.confidence || 0
        };
      }

      throw new Error('PaddleOCR返回数据格式错误');
    } catch (error) {
      console.error('Web OCR failed:', error);
      throw error;
    }
  }, []);

  // 备用OCR（在线）
  const callBackupOCR = useCallback(async (base64Image) => {
    const resp = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': 'helloworld' },
      body: JSON.stringify({
        base64Image: `data:image/png;base64,${base64Image}`,
        language: 'chs',
        isOverlayRequired: false,
        OCREngine: 2
      })
    });
    const data = await resp.json();
    if (data.ParsedResults && data.ParsedResults[0]) {
      return { text: data.ParsedResults[0].ParsedText, confidence: 75 };
    }
    throw new Error('备用OCR服务不可用');
  }, []);

  // 新的材料表OCR调用函数
  const callMaterialOCR = useCallback(async (canvas, region, splitLines = []) => {
    // 检查运行环境
    const electronAvailable = isElectron();

    if (!electronAvailable) {
      console.error('不在Electron环境中');
      throw new Error('OCR功能需要在桌面版中使用，当前为网页开发环境');
    }
    
    // 准备符合后端期望的模板数据格式
    const template = {
      materialArea: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        page: currentPage || 1
      },
      pipelineArea: globalPipelineArea ? { ...globalPipelineArea, page: currentPage || 1 } : undefined,
      pipeClassArea: globalPipeClassArea ? { ...globalPipeClassArea, page: currentPage || 1 } : undefined,
      pageNumberArea: globalPageNumberArea ? { ...globalPageNumberArea, page: currentPage || 1 } : undefined,
      drawingNumberArea: globalDrawingNumberArea ? { ...globalDrawingNumberArea, page: currentPage || 1 } : undefined,
      scaffoldArea: globalScaffoldArea ? { ...globalScaffoldArea, page: currentPage || 1 } : undefined,
      columns: splitLines.map((line) => ({
        x: line.x,
        page: currentPage || 1
      }))
    };
    
    return new Promise(async (resolve, reject) => {
      try {
        // 获取图片数据 (Base64)
        let base64Image;
        
        if (renderMode === 'svg') {
          // SVG模式：使用OCRUtils进行离屏渲染截图
          const ocrUtils = new OCRUtils(pageRefsRef, currentPage, scale, pageObjectsRef);
          try {
            base64Image = await ocrUtils.getRegionBase64(region);
          } catch (e) {
            console.error('SVG模式截图失败:', e);
            // 降级尝试：如果Canvas可用（可能混合模式），尝试从Canvas获取
            if (canvas) {
               base64Image = canvas.toDataURL('image/png').split(',')[1];
            } else {
               throw e;
            }
          }
        } else {
          // Canvas模式：直接从Canvas获取
          if (!canvas) throw new Error('Canvas元素未找到');
          base64Image = canvas.toDataURL('image/png').split(',')[1];
        }

        // 获取PDF文件的ArrayBuffer
        let arrayBuffer;
        if (typeof file === 'string') {
          // 如果是URL，需要先获取ArrayBuffer
          const response = await fetch(file);
          arrayBuffer = await response.arrayBuffer();
        } else if (file instanceof File) {
          arrayBuffer = await file.arrayBuffer();
        } else {
          throw new Error('不支持的文件类型');
        }
        
        // 转换为base64 - 使用分块处理避免栈溢出
        const uint8Array = new Uint8Array(arrayBuffer);
        const chunkSize = 8192; // 8KB chunks
        let binaryString = '';
        
        for (let i = 0; i < uint8Array.length; i += chunkSize) {
          const chunk = uint8Array.slice(i, i + chunkSize);
          binaryString += String.fromCharCode(...chunk);
        }
        
        const pdfData = btoa(binaryString);
        
        // 设置结果监听器
        const handleResult = (data) => {
          window.electronAPI.removeOCRListeners();
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data);
          }
        };
        
        // 设置进度监听器（可选）
        const handleProgress = (data) => {
          // OCR进度处理
        };
        
        // 注册监听器
        window.electronAPI.onOCRResult(handleResult);
        window.electronAPI.onOCRProgress(handleProgress);
        
        // 发送OCR请求，包含PDF数据
        window.electronAPI.runMaterialOCR(file, template, pdfData);
        
        // 设置超时（30秒）
        setTimeout(() => {
          window.electronAPI.removeOCRListeners();
          reject(new Error('OCR处理超时'));
        }, 30000);
      } catch (error) {
        console.error('获取PDF数据失败:', error);
        reject(error);
      }
    });
  }, [file, currentPage, globalPipelineArea, globalPipeClassArea, globalPageNumberArea, globalDrawingNumberArea, globalScaffoldArea, isElectron, pageObjectsRef, pageRefsRef, scale, renderMode]);

  // 保持向后兼容的callPaddleOCR函数
  const callPaddleOCR = useCallback(async (canvas, options = {}) => {
    try {
      // 对于材料表识别，使用新的OCR服务
      if (options.type === 'material' || options.isMaterialTable) {
        const result = await callMaterialOCR(canvas, options.region, options.splitLines);
        return result;
      }

      // 其他情况保持原有逻辑
      return await callLocalPaddleOCR(canvas.toDataURL('image/png').split(',')[1], options);
    } catch (error) {
      console.error('🔍 callPaddleOCR - OCR调用失败:', error);
      // 返回空结果而不是undefined
      return { materials: [], text: '', rawLogicalRows: [] };
    }
  }, [callMaterialOCR, callLocalPaddleOCR]);

  // 文本后处理函数（如果需要）
  const postProcessOCRText = useCallback((text) => {
    if (!text) return '';
    
    // 基本的文本清理
    return text
      .replace(/[""'']/g, '"') // 统一引号
      .replace(/—/g, '-') // 统一破折号
      .replace(/\s+/g, ' ') // 合并多个空格
      .trim();
  }, []);

  // 材料类型判断函数
  const determineMaterialType = useCallback((description) => {
    if (!description) return '其他';
    
    const desc = description.toLowerCase();
    if (desc.includes('管') || desc.includes('pipe')) return '管材';
    if (desc.includes('阀') || desc.includes('valve')) return '阀门';
    if (desc.includes('弯头') || desc.includes('elbow')) return '管件';
    if (desc.includes('法兰') || desc.includes('flange')) return '法兰';
    if (desc.includes('焊条') || desc.includes('电焊条')) return '焊材';
    
    return '其他';
  }, []);

  // 解析材料表结构化数据
  const parseMaterialTableStructured = useCallback((ocrText) => {
    const materials = [];
    if (!ocrText) return materials;

    // 应用文本后处理
    const processedText = postProcessOCRText(ocrText);
    const text = processedText.replace(/\t/g, ' ').replace(/[|]/g, ' ');

    // 增强的正则表达式模式，支持更多格式
    const patterns = [
      // 标准格式：序号 描述 规格 代码 数量 单位
      /(\d+)\s+([^\n]+?)\s+(\d+(?:×\d+)?(?:\.\d+)?(?:Φ\d+)?)\s+([A-Z0-9\-\.]+)\s+(\d+(?:\.\d+)?)\s*([A-Za-z]*)/g,
      // 带Φ的规格格式
      /(\d+)\s+([^\n]+?)\s+(Φ\d+(?:×\d+)?(?:\.\d+)?)\s+([A-Z0-9\-\.]+)\s+(\d+(?:\.\d+)?)\s*([A-Za-z]*)/g,
      // 无序号格式：描述 规格 代码 数量 单位
      /([^\n]+?)\s+(\d+(?:×\d+)?(?:\.\d+)?(?:Φ\d+)?)\s+([A-Z0-9\-\.]+)\s+(\d+(?:\.\d+)?)\s*([A-Za-z]*)/g,
      // 简化格式：描述 规格 数量
      /([^\n]+?)\s+(\d+(?:×\d+)?(?:\.\d+)?(?:Φ\d+)?)\s+(\d+(?:\.\d+)?)\s*([A-Za-z]*)/g
    ];

    let serial = 1;
    const processedItems = new Set(); // 避免重复项
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let item;
        
        if (match.length === 7) { // 完整格式
          const description = postProcessOCRText(match[2].trim());
          const specification = postProcessOCRText(match[3].trim());
          const code = postProcessOCRText(match[4].trim());
          const quantity = postProcessOCRText(match[5].trim());
          const unit = postProcessOCRText(match[6].trim());
          
          item = {
            key: serial,
            序号: parseInt(match[1], 10),
            材料描述: description,
            规格: specification,
            材料代码: code,
            数量: quantity,
            单位: unit || '个',
            类型: determineMaterialType(description)
          };
        } else if (match.length === 6) { // 无序号格式
          const description = postProcessOCRText(match[1].trim());
          const specification = postProcessOCRText(match[2].trim());
          const code = postProcessOCRText(match[3].trim());
          const quantity = postProcessOCRText(match[4].trim());
          const unit = postProcessOCRText(match[5].trim());
          
          item = {
            key: serial,
            序号: serial,
            材料描述: description,
            规格: specification,
            材料代码: code,
            数量: quantity,
            单位: unit || '个',
            类型: determineMaterialType(description)
          };
        } else if (match.length === 5) { // 简化格式
          const description = postProcessOCRText(match[1].trim());
          const specification = postProcessOCRText(match[2].trim());
          const quantity = postProcessOCRText(match[3].trim());
          const unit = postProcessOCRText(match[4].trim());
          
          item = {
            key: serial,
            序号: serial,
            材料描述: description,
            规格: specification,
            材料代码: '', // 无代码
            数量: quantity,
            单位: unit || '个',
            类型: determineMaterialType(description)
          };
        }
        
        // 验证和去重
        if (item && item.材料描述.length > 1) {
          const itemKey = `${item.材料描述}_${item.规格}_${item.数量}`;
          if (!processedItems.has(itemKey)) {
            processedItems.add(itemKey);
            materials.push(item);
            serial += 1;
          }
        }
      }
    }
    
    return materials;
  }, [determineMaterialType, postProcessOCRText]);

  // Excel导出功能
  const exportToExcel = useCallback((materials) => {
    if (!materials || materials.length === 0) {
      message.warning('没有可导出的数据');
      return;
    }

    try {
      // 创建工作簿
      const wb = XLSX.utils.book_new();
      
      // 转换为二维数组格式（参考原项目方式）
      let sheetData;
      if (Array.isArray(materials[0])) {
        // 如果已经是二维数组，直接使用
        sheetData = materials;
      } else {
        // 转换对象数组为二维数组
        sheetData = materials.map((item, index) => [
          item.序号 || index + 1,
          item.材料描述 || item.text || '',
          item.规格 || '',
          item.材料代码 || '',
          item.数量 || '',
          item.单位 || '',
          item.类型 || ''
        ]);
      }
      
      // 根据材料编号计算页码并添加到数据中
      const dataWithPageNumbers = [];
      let currentPage = 1;
      
      for (let i = 0; i < sheetData.length; i++) {
        const row = sheetData[i];
        const materialNumber = row[0];
        
        // 如果材料编号为1且不是第一行，说明开始新的一页
        if (materialNumber === '1' && i > 0) {
          currentPage++;
        }
        
        // 将计算的页码添加到行数据的第9列（第8列是OCR识别的页码）
        const rowWithPage = [...row, currentPage];
        dataWithPageNumbers.push(rowWithPage);
      }
      
      // 添加列标题
      const headers = ['材料编号', '材料描述', '规格', '材料代码', '数量', '管线号', '图号', 'OCR页码', '计算页码'];
      const dataWithHeaders = [headers, ...dataWithPageNumbers];
      
      // 使用aoa_to_sheet创建工作表（参考原项目）
      const ws = XLSX.utils.aoa_to_sheet(dataWithHeaders);
      
      // 设置列宽以完整显示信息
       const colWidths = [
         { wch: 12 }, // 材料编号
         { wch: 40 }, // 材料描述
         { wch: 20 }, // 规格
         { wch: 15 }, // 材料代码
         { wch: 10 }, // 数量
         { wch: 15 }, // 管线号
         { wch: 25 }, // 图号
         { wch: 12 }, // OCR页码
         { wch: 12 }  // 计算页码
       ];
      ws['!cols'] = colWidths;
      
      // 添加工作表到工作簿（参考原项目工作表名）
      XLSX.utils.book_append_sheet(wb, ws, '识别结果');
      
      // 生成文件名（参考原项目格式）
      const timestamp = Date.now();
      const filename = `ocr_result_${timestamp}.xlsx`;
      
      // 导出文件
      XLSX.writeFile(wb, filename);
      
      message.success(`Excel文件已导出: ${filename}`);
    } catch (error) {
      console.error('Excel导出失败:', error);
      message.error('Excel导出失败: ' + error.message);
    }
  }, []);

  // 动态生成材料表格列定义
  const generateMaterialColumns = useCallback((materials) => {
    if (!materials || materials.length === 0) {
      return [];
    }

    // 从第一行数据中获取所有字段
    const firstRow = materials[0];
    const columns = [];

    // 遍历第一行的所有字段生成列配置
    Object.keys(firstRow).forEach(key => {
      if (key === 'key') return; // 跳过内部key字段

      columns.push({
        title: key,
        dataIndex: key,
        key: key,
        width: 120,
        ellipsis: true
      });
    });

    return columns;
  }, []);

  return {
    // 工具函数
    isElectron,
    callLocalPaddleOCR,
    callWebPaddleOCR,
    callBackupOCR,
    callMaterialOCR,
    callPaddleOCR,
    postProcessOCRText,
    determineMaterialType,
    parseMaterialTableStructured,
    exportToExcel,
    generateMaterialColumns
  };
};

export default usePDFUtils;
