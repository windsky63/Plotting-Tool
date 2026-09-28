/**
 * OCR状态管理Hook
 * 用于管理OCR相关的所有状态和操作
 */

import { useState, useCallback, useRef } from 'react';
import { message } from 'antd';
import { ocrService } from '../services/ocrService';
import { ocrDataUtils } from '../utils/ocrUtils';

export const useOCRState = () => {
  // OCR基础状态
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrStatus, setOcrStatus] = useState('准备中...');
  const [ocrStopping, setOcrStopping] = useState(false);
  const [currentOcrProcess, setCurrentOcrProcess] = useState(null);

  // OCR区域相关状态
  const [globalOcrRegion, setGlobalOcrRegion] = useState(null);
  const [globalOcrResults, setGlobalOcrResults] = useState([]);
  const [ocrAreaTarget, setOcrAreaTarget] = useState('material');
  const [selectedDetectionIndices, setSelectedDetectionIndices] = useState({}); // 按页码存储选中索引 { pageNumber: Set<index> }

  // OCR交互状态
  const [ocrState, setOcrState] = useState({
    isActive: false,
    mode: 'idle', // 'idle', 'selecting', 'splitLine'
    region: null,
    splitLines: [],
    dragState: {
      isDragging: false,
      startPoint: null
    },
    resizeState: {
      isResizing: false,
      handle: null,
      originalRegion: null,
      startPoint: null
    },
    results: {
      visible: false,
      materials: [],
      rawLogicalRows: []
    }
  });

  // 引用变量
  const ocrLogicalRows = useRef([]);
  const stopRequestedRef = useRef(false);

  const normalizePageSelection = (pageSelection, totalPages) => {
    if (!pageSelection) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    if (pageSelection.type === 'range') {
      const start = Math.max(1, parseInt(pageSelection.start, 10) || 1);
      const end = Math.min(totalPages, parseInt(pageSelection.end, 10) || totalPages);
      if (start > end) return [];
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }

    if (pageSelection.type === 'custom' && Array.isArray(pageSelection.pages)) {
      return Array.from(new Set(pageSelection.pages
        .map(page => parseInt(page, 10))
        .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages)
      )).sort((a, b) => a - b);
    }

    return Array.from({ length: totalPages }, (_, index) => index + 1);
  };

  /**
   * 启动全部识别（WebSocket双向通信，Web端使用逐页识别）
   * @param {string|File|Blob} pdfPath - PDF文件路径或文件对象
   */
  const startRecognizeAll = useCallback(async ({ pdfPath, template, onPageComplete, onJumpPage, onPageStart, onStopped, onCompleted, totalPages: paramTotalPages, pageRange }) => {
    try {
      console.log('🚀 启动全部OCR识别流程...');
      
      // 🌐 Web端支持：检测是否有有效的文件路径或文件对象
      const isFileObject = pdfPath instanceof File || pdfPath instanceof Blob;
      const isValidPath = typeof pdfPath === 'string' && pdfPath.length > 0 && !pdfPath.startsWith('blob:');
      
      let pdfFile = null;
      let actualPdfPath = null;
      
      if (isFileObject) {
        pdfFile = pdfPath;
        console.log('🌐 [Web] 使用文件对象进行全部识别');
      } else if (isValidPath) {
        actualPdfPath = pdfPath;
      } else if (window.__lastOpenedPdfFile__) {
        pdfFile = window.__lastOpenedPdfFile__;
        console.log('🌐 [Web] 使用全局保存的文件对象进行全部识别');
      } else {
        console.error('❌ PDF路径和文件对象都不可用');
        throw new Error('无法获取PDF文件：请重新打开PDF文件后再试');
      }
      
      if (!template) {
        console.error('❌ 模板不可用');
        throw new Error('模板不可用');
      }
      
      console.log('📋 全部识别参数:', { 
        pdfPath: actualPdfPath || (pdfFile ? pdfFile.name : 'unknown'),
        isWebMode: !!pdfFile,
        hasTemplate: !!template,
        templateKeys: Object.keys(template || {}),
        templateType: template?.type || 'unknown',
        templateSize: JSON.stringify(template || {}).length
      });
      
      // 为支架识别添加特殊的调试信息
      if (template?.type === 'scaffold' || template?.scaffoldFields) {
        console.log('🏗️ 支架模板详细信息:', {
          hasScaffoldFields: !!template.scaffoldFields,
          scaffoldFieldCount: template.scaffoldFields ? Object.keys(template.scaffoldFields).length : 0,
          hasRegions: !!template.regions,
          regionCount: template.regions ? template.regions.length : 0,
          templateStructure: Object.keys(template).filter(key => template[key] != null)
        });
      }
      
      stopRequestedRef.current = false;
      setOcrProgress(0);
      
      // 🌐 Web端：使用逐页识别方式（因为WebSocket需要文件路径）
      if (pdfFile && !actualPdfPath) {
        console.log('🌐 [Web] 使用逐页识别方式进行全部识别...');
        setOcrStatus('启动Web端识别...');
        
        // 获取总页数（需要从外部传入或通过其他方式获取）
        const totalPages = paramTotalPages || 1;
        const pagesToRecognize = normalizePageSelection(pageRange, totalPages);
        if (pagesToRecognize.length === 0) {
          throw new Error('没有可识别的页码');
        }
        console.log(`🌐 [Web] 总页数: ${totalPages}`);
        
        // 创建一个模拟的进程对象
        const proc = { taskId: `web-${Date.now()}`, cancelled: false };
        setCurrentOcrProcess(proc);
        
        try {
          for (let pageIndex = 0; pageIndex < pagesToRecognize.length; pageIndex += 1) {
            const page = pagesToRecognize[pageIndex];
            // 检查是否被取消
            if (stopRequestedRef.current || proc.cancelled) {
              console.log(`🛑 [Web] 识别被停止在第${page}页`);
              setOcrStatus(`识别已停止（停在第${page}页）`);
              onStopped?.(page);
              break;
            }
            
            // 更新进度
            const progress = Math.round(((pageIndex + 1) / pagesToRecognize.length) * 100);
            setOcrProgress(progress);
            setOcrStatus(`正在识别第${page}页...`);
            onPageStart?.(page);
            
            try {
              // 调用单页识别
              const recognitionData = await ocrService.recognizeSinglePage(pdfFile, template, page);
              
              console.log(`📦 [Web] 第${page}页识别完成:`, {
                materials: recognitionData.materials?.length || 0,
                scaffolds: recognitionData.scaffolds?.length || 0,
                detections: recognitionData.detections?.length || 0
              });
              
              // 处理页面数据
              onPageComplete?.(page, recognitionData);
              
              // 跳转到当前页面
              if (onJumpPage) {
                onJumpPage(page);
              }
              
              // 稍微延迟以允许UI更新
              await new Promise(resolve => setTimeout(resolve, 100));
              
            } catch (pageError) {
              console.error(`❌ [Web] 第${page}页识别失败:`, pageError);
              setOcrStatus(`第${page}页识别失败: ${pageError.message}`);
              // 继续处理下一页
            }
          }
          
          // 完成
          if (!stopRequestedRef.current && !proc.cancelled) {
            setOcrProgress(100);
            setOcrStatus('全部识别完成');
            onCompleted?.();
          }
          
        } finally {
          setCurrentOcrProcess(null);
          setOcrStopping(false);
        }
        
        return; // Web端处理完成，直接返回
      }
      
      // Electron端：使用WebSocket识别
      setOcrStatus('启动WebSocket识别...');
      
      // 启动WebSocket识别
      console.log('🔌 正在建立WebSocket连接...');
      const { taskId, websocket } = await ocrService.startWebSocketRecognition(actualPdfPath, template, {
        onStarted: (totalPages, taskId) => {
          setOcrStatus(`开始识别，共${totalPages}页`);
        },
        
        onPageStart: (page) => {
          setOcrStatus(`正在识别第${page}页...`);
          onPageStart?.(page);
        },
        
        onPageCompleted: async (page, data, detections, progress, websocket) => {
          setOcrProgress(progress);
          setOcrStatus(`第${page}页识别完成`);
          
          console.log(`📦 useOCRState-第${page}页数据:`, {
            materials: data.materials?.length || 0,
            scaffolds: data.scaffolds?.length || 0,
            dataDetections: data.detections?.length || 0,
            paramDetections: detections?.length || 0,
            keys: Object.keys(data)
          });
          
          // 立即处理页面数据
          onPageComplete?.(page, { ...data, detections });
          
          // 跳转到当前页面
          if (onJumpPage) {
            onJumpPage(page);
          }
          
          // 等待DOM更新完成后发送确认
          // 🚀 使用setTimeout替代requestAnimationFrame，确保窗口在后台时也能继续识别
          await new Promise(resolve => {
            setTimeout(() => {
              // 发送渲染完成确认
              ocrService.confirmPageRendered(websocket, page);
              resolve();
            }, 50); // 50ms足够让React完成状态更新
          });
        },
        
        onPageError: (page, error) => {
          console.error(`第${page}页识别失败:`, error);
          setOcrStatus(`第${page}页识别失败: ${error}`);
        },
        
        onStopped: (page) => {
          setOcrStatus(`识别已停止（停在第${page}页）`);
          setCurrentOcrProcess(null);
          setOcrStopping(false);
          // 调用传入的onStopped回调
          onStopped?.(page);
        },
        
        onCompleted: () => {
          setOcrProgress(100);
          setOcrStatus('全部识别完成');
          setCurrentOcrProcess(null);
          setOcrStopping(false);
          // 调用传入的完成回调
          if (onCompleted) {
            onCompleted();
          }
        },
        
        onFailed: (error) => {
          setOcrStatus(`识别失败: ${error}`);
          setCurrentOcrProcess(null);
          setOcrStopping(false);
          onStopped?.(null);
          throw new Error(error);
        },
        
        onError: (error) => {
          console.error('WebSocket连接错误:', error);
          setOcrStatus('连接中断');
          setCurrentOcrProcess(null);
          setOcrStopping(false);
          onStopped?.(null);
        }
      });
      
      // 保存进程信息
      const proc = { taskId, websocket, cancelled: false };
      setCurrentOcrProcess(proc);
      
    } catch (error) {
      console.error('❌ 启动全部识别失败:', error);
      console.error('💡 可能的原因:');
      if (error.message.includes('WebSocket')) {
        console.error('  1. OCR服务未启动或WebSocket连接失败');
        console.error('  2. 端口配置错误或被占用');
        console.error('  3. 防火墙阻止WebSocket连接');
        setOcrStatus('WebSocket连接失败');
      } else if (error.message.includes('PDF')) {
        console.error('  1. PDF文件路径错误或文件不存在');
        console.error('  2. PDF文件损坏或格式不支持');
        console.error('  3. 文件访问权限问题');
        setOcrStatus('PDF文件访问失败');
      } else if (error.message.includes('模板')) {
        console.error('  1. 模板配置缺失或格式错误');
        console.error('  2. 模板字段不完整');
        setOcrStatus('模板配置错误');
      } else {
        console.error('  1. OCR服务未启动');
        console.error('  2. 网络连接问题');
        console.error('  3. 服务器内部错误');
        setOcrStatus('启动识别失败');
      }
      setCurrentOcrProcess(null);
      setOcrStopping(false);
      throw error;
    }
  }, []);

  /**
   * 停止OCR识别
   */
  const handleStopOCR = useCallback(async () => {
    if (currentOcrProcess && !ocrStopping) {
      setOcrStopping(true);
      setOcrStatus('正在停止识别...');
      
      try {
        // WebSocket识别停止
        if (currentOcrProcess && currentOcrProcess.websocket) {
          // 发送停止请求
          ocrService.requestStopRecognition(currentOcrProcess.websocket);
          // 关闭WebSocket连接
          ocrService.closeWebSocket(currentOcrProcess.websocket);
        }
        // 旧的任务ID停止
        else if (currentOcrProcess && currentOcrProcess.taskId) {
          try { 
            await ocrService.stopRecognition(currentOcrProcess.taskId);
          } catch (e) {
            console.error('停止识别失败:', e);
          }
        } 
        // Electron批量识别停止
        else if (window.electronAPI && window.electronAPI.stopBatchOCR) {
          const stopResult = await window.electronAPI.stopBatchOCR();
        }
        // Web端批量识别停止
        else {
          const stopResult = await ocrService.stopBatchOCR();
        }
        
      } catch (error) {
        console.error('停止OCR失败:', error);
      }
      
      // 立即重置所有状态，释放OCR引擎
      setCurrentOcrProcess(null);
      setOcrStopping(false);
      setOcrProgress(0);
      setOcrStatus('识别已停止');
      stopRequestedRef.current = false;
      
    } else {
      // 直接重置状态
      setOcrProgress(0);
      setOcrStatus('准备中...');
      setOcrStopping(false);
      setCurrentOcrProcess(null);
    }
  }, [currentOcrProcess, ocrStopping]);

  /**
   * 单页OCR识别
   * @param {Object} templateData - 模板数据
   * @param {number} currentPage - 当前页码
   * @param {string|File|Blob} pdfPathOrFile - PDF文件路径或文件对象
   */
  const handleRecognizeSinglePage = useCallback(async (templateData = null, currentPage = 1, pdfPathOrFile = null) => {
    try {
      console.log('🔧 开始单页OCR识别...');
      
      // 🌐 Web端支持：检测是否有有效的文件路径或文件对象
      const isFileObject = pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob;
      const isValidPath = typeof pdfPathOrFile === 'string' && pdfPathOrFile.length > 0 && !pdfPathOrFile.startsWith('blob:');
      
      if (!isFileObject && !isValidPath) {
        // 尝试使用全局保存的文件对象
        if (window.__lastOpenedPdfFile__) {
          pdfPathOrFile = window.__lastOpenedPdfFile__;
          console.log('🌐 [Web] 单页识别使用全局保存的文件对象');
        } else {
          console.error('❌ PDF路径和文件对象都不可用');
          throw new Error('无法获取PDF文件：请重新打开PDF文件后再试');
        }
      }

      // 验证模板数据
      if (templateData) {
        // 判断模板类型
        const isMixed = templateData.materialArea && 
                       templateData.scaffoldArea &&
                       typeof templateData.materialArea.x === 'number' &&
                       typeof templateData.scaffoldArea.x === 'number';
        
        const isScaffold = !isMixed && templateData.scaffoldArea && 
                          (templateData.materialArea === null || templateData.materialArea === undefined);
        
        if (isMixed) {
          // 验证混合模板的 materialArea 和 scaffoldArea
          console.log('🔀 检测到混合模板，验证材料区域和支架区域');
          
          if (typeof templateData.materialArea.x !== 'number' || 
              typeof templateData.materialArea.y !== 'number' ||
              typeof templateData.materialArea.width !== 'number' ||
              typeof templateData.materialArea.height !== 'number') {
            console.error('❌ 混合模板materialArea配置无效:', templateData);
            throw new Error('混合模板配置无效：materialArea 必须包含有效的 x, y, width, height 坐标');
          }
          
          if (typeof templateData.scaffoldArea.x !== 'number' || 
              typeof templateData.scaffoldArea.y !== 'number' ||
              typeof templateData.scaffoldArea.width !== 'number' ||
              typeof templateData.scaffoldArea.height !== 'number') {
            console.error('❌ 混合模板scaffoldArea配置无效:', templateData);
            throw new Error('混合模板配置无效：scaffoldArea 必须包含有效的 x, y, width, height 坐标');
          }
        } else if (isScaffold) {
          // 验证支架模板的scaffoldArea
          if (templateData.scaffoldArea &&
              (typeof templateData.scaffoldArea.x !== 'number' || 
               typeof templateData.scaffoldArea.y !== 'number' ||
               typeof templateData.scaffoldArea.width !== 'number' ||
               typeof templateData.scaffoldArea.height !== 'number')) {
            console.error('❌ 支架模板配置无效:', templateData);
            throw new Error('支架模板配置无效：scaffoldArea 必须包含有效的 x, y, width, height 坐标');
          }
        } else if (templateData.materialArea) {
          // 验证普通模板的materialArea
          if (typeof templateData.materialArea.x !== 'number' || 
              typeof templateData.materialArea.y !== 'number' ||
              typeof templateData.materialArea.width !== 'number' ||
              typeof templateData.materialArea.height !== 'number') {
            console.error('❌ 模板配置无效:', templateData);
            throw new Error('模板配置无效：materialArea 必须包含有效的 x, y, width, height 坐标');
          }
        }
      }

      console.log('📄 单页识别参数:', {
        pdfPathOrFile: pdfPathOrFile instanceof File ? pdfPathOrFile.name : pdfPathOrFile,
        isWebMode: pdfPathOrFile instanceof File || pdfPathOrFile instanceof Blob,
        currentPage: currentPage,
        hasTemplate: !!templateData
      });

      setOcrStatus('正在识别单页...');
      const recognitionData = await ocrService.recognizeSinglePage(pdfPathOrFile, templateData, currentPage);
      
      console.log('✅ 单页识别完成，返回数据:', {
        materials: recognitionData.materials?.length || 0,
        scaffolds: recognitionData.scaffolds?.length || 0,
        detections: recognitionData.detections?.length || 0,
        keys: Object.keys(recognitionData)
      });
      
      setOcrStatus('单页识别完成');
      return recognitionData;
    } catch (error) {
      console.error('❌ 单页OCR识别失败:', error);
      console.error('💡 可能的原因:');
      if (error.message.includes('无法连接')) {
        console.error('  1. OCR服务未启动');
        console.error('  2. 端口配置错误');
        console.error('  3. 防火墙阻止连接');
        setOcrStatus('OCR服务连接失败');
      } else if (error.message.includes('超时')) {
        console.error('  1. PDF文件过大');
        console.error('  2. OCR服务响应缓慢');
        console.error('  3. 网络连接问题');
        setOcrStatus('识别超时');
      } else if (error.message.includes('503')) {
        console.error('  1. OCR引擎正在初始化');
        console.error('  2. 模型文件加载失败');
        console.error('  3. 依赖库问题');
        setOcrStatus('OCR服务未就绪');
      } else {
        console.error('  1. PDF文件问题');
        console.error('  2. 模板配置错误');
        console.error('  3. 服务器内部错误');
        setOcrStatus('识别失败');
      }
      throw error;
    }
  }, []);

  /**
   * 批量OCR处理
   */
  const handleBatchOCR = useCallback(async (params) => {
    if (ocrStopping || currentOcrProcess) {
      return;
    }

    try {
      // 重置状态
      setOcrProgress(0);
      setOcrStatus('正在准备批量识别...');

      // 创建进度回调
      const onProgress = (progressData) => {
        setOcrProgress(progressData.progress || 0);
        setOcrStatus(progressData.status || '正在处理...');
      };

      // 执行批量OCR（同时支持Electron和Web端）
      // 注意：ocrService.runBatchOCR 会自动检测环境并选择合适的方式
      {
        const ocrPromise = ocrService.runBatchOCR(params, onProgress);

        // 创建可取消的Promise
        const cancelablePromise = {
          promise: ocrPromise,
          cancel: () => {
            return handleStopOCR();
          },
          cancelled: false
        };

        setCurrentOcrProcess(cancelablePromise);

        const result = await ocrPromise;

        // 处理结果（包括停止的情况）
        if (result && result.success) {
          
          let finalLogicalRows = [];
          let isStoppedResult = false;
          
          // 检查是否是停止的结果
          if (result.stopped_at_page !== undefined) {
            isStoppedResult = true;
          }
          
          // 处理逻辑行数据
          if (result.logical_rows && Array.isArray(result.logical_rows)) {
            // 检查第一个元素是否已经是逻辑行格式（数组）
            if (result.logical_rows.length > 0 && Array.isArray(result.logical_rows[0])) {
              // 已经是解析好的逻辑行数组，直接使用
              finalLogicalRows = result.logical_rows;
            } else {
              // 还是页面格式，需要解析
              const extractCell = (rowObj, idx) => {
                const key = `column${idx}`;
                const cell = rowObj?.[key];
                if (cell && typeof cell === 'object') return cell.text || '';
                return cell || '';
              };

              result.logical_rows.forEach((pageObj, pageIndex) => {
                const pipelineText = pageObj?.pipeline?.text || '';
                const drawingText = pageObj?.drawingNumber?.text || '';
                const pageText = pageObj?.pageNumber?.text || '';
                const materials = Array.isArray(pageObj?.material) ? pageObj.material : [];

                console.log(`处理第${pageIndex}页:`, {
                  pipelineText,
                  drawingText,
                  pageText,
                  materialsLength: materials.length,
                  pageObjKeys: Object.keys(pageObj)
                });

                materials.forEach((rowObj, rowIndex) => {
                  const row = [
                    extractCell(rowObj, 1), // 序号
                    extractCell(rowObj, 2), // 材料描述
                    extractCell(rowObj, 3), // 规格
                    extractCell(rowObj, 4), // 材料代码
                    extractCell(rowObj, 5), // 数量
                    pipelineText,          // 管线号
                    drawingText,           // 图号
                    pageText               // 页码
                  ];

                  console.log(`添加第${rowIndex}行:`, row);
                  finalLogicalRows.push(row);
                });
              });
            }
          }


          if (finalLogicalRows.length > 0) {
            // 保存识别结果
            ocrLogicalRows.current = finalLogicalRows;
            setOcrProgress(100);

            // MinerU 来源且服务端已真正完成 Excel 下载，跳过前端导出直接通知完成
            console.log('[MinerU] fromMinerU:', result.fromMinerU, '| serverExcelDownloaded:', result.serverExcelDownloaded);
            if (result.fromMinerU && result.serverExcelDownloaded) {
              setOcrStatus(`MinerU 识别完成，共 ${finalLogicalRows.length} 行，Excel 已下载`);
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('ocr-batch-completed', {
                  detail: {
                    success: true,
                    fileName: `MinerU.xlsx`,
                    totalRows: finalLogicalRows.length,
                    stopped: isStoppedResult
                  }
                }));
              }, 3000);
              return result;
            }
            
            const statusText = isStoppedResult ? 
              `识别已停止，正在导出已处理的 ${finalLogicalRows.length} 行数据...` : 
              (params.enableMaterialEncoding ? '正在进行材料编码...' : '正在导出Excel...');
            setOcrStatus(statusText);

            // 自动导出结果
            try {
              // 设置当前标注数据，供焊口关联使用
              window.currentAnnotations = params.annotations || [];
              
              const { fileName } = await ocrDataUtils.exportLogicalRowsToExcel(
                finalLogicalRows,
                params.pdfFileName,
                params.enableMaterialEncoding // 传递材料编码开关状态
              );
              
              const successMessage = isStoppedResult ? 
                `识别已停止，已导出截至停止页的数据` :
                `批量识别完成，已自动导出Excel`;
              
              setOcrStatus(successMessage);
              
              const messageText = isStoppedResult ?
                `识别已停止！已导出截至停止页的 ${finalLogicalRows.length} 行数据到 ${fileName}` :
                `批量识别完成！已导出 ${finalLogicalRows.length} 行数据到 ${fileName}`;
                
                // 延迟3秒后自动关闭弹窗
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('ocr-batch-completed', { 
                  detail: { 
                    success: true, 
                    fileName, 
                    totalRows: finalLogicalRows.length,
                    stopped: isStoppedResult
                  } 
                }));
              }, 3000);
            } catch (exportError) {
              console.error('Excel导出失败:', exportError);
              setOcrStatus('识别完成，但Excel导出失败');
              message.error('识别完成，但Excel导出失败');
              
              // 即使导出失败也要通知完成
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('ocr-batch-completed', { 
                  detail: { 
                    success: false, 
                    error: exportError.message 
                  } 
                }));
              }, 2000);
            }
          } else {
            console.warn('⚠️ 未检测到表格数据，详细分析:', {
              finalLogicalRows长度: finalLogicalRows.length,
              result_logical_rows存在: !!result.logical_rows,
              result_logical_rows长度: result.logical_rows?.length,
              isStoppedResult: isStoppedResult,
              stopped_at_page: result.stopped_at_page,
              firstElementType: result.logical_rows?.length > 0 ? typeof result.logical_rows[0] : 'empty',
              firstElementIsArray: result.logical_rows?.length > 0 ? Array.isArray(result.logical_rows[0]) : false
            });
            
            if (isStoppedResult) {
              // 停止情况的特殊处理
              const stoppedPage = result.stopped_at_page || 0;
              if (stoppedPage === 0) {
                setOcrStatus('识别已停止，在开始处理前就被停止了');
              } else {
                setOcrStatus(`识别已在第${stoppedPage}页停止，未检测到表格内容`);
              }
            } else {
              setOcrStatus('识别完成，未检测到表格内容');
              message.info('识别完成，未检测到表格内容');
            }
            
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('ocr-batch-completed', { 
                detail: { 
                  success: true, 
                  totalRows: 0,
                  stopped: isStoppedResult
                } 
              }));
            }, 2000);
          }
          
          return result;
        } else {
          console.error('❌ 批量OCR返回结果格式错误:', result);
          setOcrStatus('识别结果格式错误');
          message.error('识别失败：结果格式错误');
          
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('ocr-batch-completed', { 
              detail: { 
                success: false, 
                error: '结果格式错误' 
              } 
            }));
          }, 2000);
          
          return null;
        }
      }
    } catch (error) {
      console.error('批量OCR失败:', error);
      
      if (currentOcrProcess && !currentOcrProcess.cancelled) {
        setOcrStatus('识别已结束');
      } else if (error.message && error.message.includes('取消')) {
        // OCR识别已取消
      } else {
        setOcrStatus('识别失败');
        message.error(`批量OCR失败: ${error.message}`);
      }
    } finally {
      // 清理状态
      setCurrentOcrProcess(null);
      setOcrStopping(false);
    }
  }, [ocrStopping, currentOcrProcess, handleStopOCR]);

  /**
   * OCR结果关联处理
   */
  const handleAssociateWithOCR = useCallback((weldSeamData) => {
    try {
      if (!weldSeamData || weldSeamData.length === 0) {
        return [];
      }

      // 使用全局变量中保存的OCR结果
      const originalOcrLogicalRows = window.lastOcrLogicalRows;
      if (!originalOcrLogicalRows || originalOcrLogicalRows.length === 0) {
        return [];
      }

      // 为OCR数据添加计算页码
      const ocrLogicalRowsWithPageNumbers = ocrDataUtils.addCalculatedPageNumbers(originalOcrLogicalRows);

      // 执行关联
      const results = ocrService.associateWeldSeamWithOCR(weldSeamData, ocrLogicalRowsWithPageNumbers);

      return results;
    } catch (error) {
      console.error('OCR关联失败:', error);
      message.error(`关联失败: ${error.message}`);
      return [];
    }
  }, []);

  /**
   * 重置OCR状态
   */
  const resetOCRState = useCallback(() => {
    setOcrProgress(0);
    setOcrStatus('准备中...');
    setOcrStopping(false);
    setCurrentOcrProcess(null);
    ocrLogicalRows.current = [];
  }, []);

  /**
   * 激活/停用OCR模式
   */
  const toggleOCRMode = useCallback((isActive) => {
    setOcrState(prev => ({
      ...prev,
      isActive,
      mode: isActive ? 'idle' : 'idle'
    }));
  }, []);

  /**
   * 设置OCR区域
   */
  const setOCRRegion = useCallback((region) => {
    setGlobalOcrRegion(region);
  }, []);

  /**
   * 清除OCR区域和结果
   */
  const clearOCRData = useCallback(() => {
    setGlobalOcrRegion(null);
    setGlobalOcrResults([]);
    setOcrState(prev => ({
      ...prev,
      region: null,
      splitLines: []
    }));
  }, []);

  // 返回状态和操作函数
  return {
    // 基础状态
    ocrProgress,
    ocrStatus,
    ocrStopping,
    currentOcrProcess,
    
    // 区域状态
    globalOcrRegion,
    globalOcrResults,
    ocrAreaTarget,
    ocrState,
    
    // 数据
    ocrLogicalRows: ocrLogicalRows.current,
    
    // 操作函数
    handleStopOCR,
    handleRecognizeSinglePage,
    handleBatchOCR,
    handleAssociateWithOCR,
    resetOCRState,
    toggleOCRMode,
    setOCRRegion,
    clearOCRData,
    startRecognizeAll,
    
    // 状态
    ocrStopping,
    
    // 状态设置函数
    setOcrProgress,
    setOcrStatus,
    setOcrAreaTarget,
    setOcrState,
    setGlobalOcrRegion,
    setGlobalOcrResults,
    
    // 选中状态管理
    selectedDetectionIndices,
    setSelectedDetectionIndices
  };
};

export default useOCRState;
