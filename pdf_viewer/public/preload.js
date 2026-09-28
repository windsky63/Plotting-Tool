const { contextBridge, ipcRenderer } = require('electron');

console.log('===== Preload脚本开始加载 =====');
console.log('contextBridge 可用:', !!contextBridge);
console.log('ipcRenderer 可用:', !!ipcRenderer);

// 立即设置一个全局标记
window.preloadLoaded = true;

// 创建API对象
const electronAPI = {
  // 监听文件打开事件
  onOpenPDF: (callback) => {
    console.log('设置PDF打开监听器');
    ipcRenderer.on('open-pdf', (event, data) => {
      // 将Buffer转换为Blob URL
      if (data && data.buffer) {
        console.log('接收到PDF文件:', data.fileName, '大小:', data.buffer.length, '字节');
        const blob = new Blob([data.buffer], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        // 同步最新的文件路径到全局，避免使用到旧路径
        if (data.filePath) {
          try { window.__lastOpenedPdfPath__ = data.filePath; } catch (e) { /* ignore */ }
        }
        callback(event, { fileName: data.fileName, url: url, filePath: data.filePath });
      } else {
        // 兼容旧的字符串格式（如果有的话）
        callback(event, data);
      }
    });
  },
  
  // 监听PDF打开错误事件
  onOpenPDFError: (callback) => {
    console.log('设置PDF错误监听器');
    ipcRenderer.on('open-pdf-error', callback);
  },
  
  // 移除监听器
  removeOpenPDFListener: (callback) => {
    console.log('移除PDF打开监听器');
    ipcRenderer.removeListener('open-pdf', callback);
  },
  
  // 移除错误监听器
  removeOpenPDFErrorListener: (callback) => {
    console.log('移除PDF错误监听器');
    ipcRenderer.removeListener('open-pdf-error', callback);
  },
  
  // 发送消息到主进程
  openPDF: () => {
    console.log('发送打开PDF消息');
    ipcRenderer.send('open-pdf-dialog');
  },

  // 通过原生对话框打开PDF文件，返回 { filePath, fileName, buffer, canceled }
  openFile: async () => {
    console.log('📂 调用openFile，打开原生文件对话框');
    return ipcRenderer.invoke('open-file-dialog');
  },

  // 所见即所得PDF导出（带文件选择对话框）
  printToPDF: (options) => {
    console.log('🖨️ 调用printToPDF，选项:', options);
    return ipcRenderer.invoke('print-to-pdf', options);
  },

  // 快速保存PDF到桌面（无对话框）
  quickSavePDF: (options) => {
    console.log('⚡ 调用quickSavePDF，选项:', options);
    return ipcRenderer.invoke('quick-save-pdf', options);
  },

  // 保存文件到指定路径
  saveFile: (filePath, data) => {
    console.log('💾 调用saveFile，路径:', filePath, '数据大小:', data?.length || 0);
    return ipcRenderer.invoke('save-file', filePath, data);
  },

  // 获取当前PDF路径
  getCurrentPdfPath: () => {
    return ipcRenderer.invoke('get-current-pdf-path');
  },

  // 设置当前PDF路径并保存到配置
  setCurrentPdfPath: (filePath) => {
    console.log('📝 设置当前PDF路径:', filePath);
    return ipcRenderer.invoke('set-current-pdf-path', filePath);
  },
  
  // PaddleOCR功能
  paddleOCR: (base64Image) => {
    return ipcRenderer.invoke('paddle-ocr', base64Image);
  },
  
  checkPaddleOCR: () => {
    return ipcRenderer.invoke('check-paddle-ocr');
  },
  
  // 材料表OCR功能
  runMaterialOCR: (pdfPath, template) => {
    ipcRenderer.send('run-material-ocr', { pdfPath, template });
  },
  
  // 批量OCR功能
  runBatchOCR: async ({ pdfFile, template, onProgress }) => {
    try {
      // 从前端配置文件获取端口信息
      const configResponse = await fetch('./app-config.json');
      if (!configResponse.ok) {
        throw new Error('无法读取配置文件app-config.json');
      }

      const config = await configResponse.json();
      const port = config.ocr_server_port;

      if (!port) {
        throw new Error('配置文件中缺少OCR服务端口信息，请检查app-config.json文件中的ocr_server_port配置');
      }

      // 构建API URL
      const apiUrl = `http://127.0.0.1:${port}/api/recognize/batch`;

      // 获取PDF文件的实际路径
      let pdfPath = '';
      // 方式A：如果pdfFile是对象且携带path
      if (!pdfPath && pdfFile && typeof pdfFile === 'object' && pdfFile.path) {
        pdfPath = pdfFile.path;
      }
      // 方式B：如果pdfFile是字符串且不是blob:，且看起来像路径
      if (!pdfPath && typeof pdfFile === 'string' && (pdfFile.includes('\\') || pdfFile.includes('/')) && !pdfFile.startsWith('blob:')) {
        pdfPath = pdfFile;
      }
      // 方式C：向主进程查询当前路径
      if (!pdfPath) {
        try {
          const mainPath = await ipcRenderer.invoke('get-current-pdf-path');
          if (mainPath) pdfPath = mainPath;
        } catch (error) {
          console.error('❌ 获取PDF路径失败:', error);
        }
      }
      // 方式D：最后再回退到旧的全局变量
      if (!pdfPath && typeof window.__lastOpenedPdfPath__ === 'string' && window.__lastOpenedPdfPath__) {
        pdfPath = window.__lastOpenedPdfPath__;
      }
      
      if (!pdfPath) {
        throw new Error('无法获取PDF文件路径。请使用"文件"菜单或Ctrl+O快捷键打开PDF文件，而不是通过网页文件选择器。OCR功能需要访问实际的文件路径。');
      }
      
      // 批量OCR时移除模板中的page属性，让OCR处理所有页面
      const batchTemplate = JSON.parse(JSON.stringify(template));
      if (batchTemplate.materialArea && batchTemplate.materialArea.page) {
        delete batchTemplate.materialArea.page;
      }
      if (batchTemplate.pipelineArea && batchTemplate.pipelineArea.page) {
        delete batchTemplate.pipelineArea.page;
      }
      if (batchTemplate.pipeClassArea && batchTemplate.pipeClassArea.page) {
        delete batchTemplate.pipeClassArea.page;
      }
      if (batchTemplate.pageNumberArea && batchTemplate.pageNumberArea.page) {
        delete batchTemplate.pageNumberArea.page;
      }
      if (batchTemplate.drawingNumberArea && batchTemplate.drawingNumberArea.page) {
        delete batchTemplate.drawingNumberArea.page;
      }
      if (batchTemplate.columns) {
        batchTemplate.columns.forEach(col => {
          if (col.page) delete col.page;
        });
      }

      // 后端统一做坐标规范化，这里不再转换坐标
      const requestBody = {
        pdf_path: pdfPath,
        template: batchTemplate
      };

      // 发送请求（JSON）
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 处理流式响应（SSE 格式：每行以 'data: ' 开头）
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasResult = false;
      let currentTaskId = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'task_id') {
                // 保存任务ID
                currentTaskId = data.task_id;
                // 将任务ID存储到全局变量，供停止功能使用
                window.currentBatchTaskId = currentTaskId;
              } else if (data.type === 'progress' && onProgress) {
                // 将后端进度格式映射到前端所需格式
                onProgress({
                  progress: data.percentage || 0,
                  status: data.phase || '处理中...',
                  currentPage: data.completed || 0,
                  totalPages: data.total || 0
                });
              } else if (data.type === 'result') {
                hasResult = true;

                // 处理统一格式：直接使用 logical_rows
                let resultData;
                let stopped = false;
                let stopped_at_page = 0;

                if (data.logical_rows) {
                  // 统一格式
                  resultData = {
                    logical_rows: data.logical_rows,
                    total_pages: data.total_pages || 0
                  };
                  stopped = !!data.stopped_at_page;
                  stopped_at_page = data.stopped_at_page || 0;
                } else {
                  // 异常情况，记录详细信息
                  console.error('异常的数据格式:', data);
                  resultData = { logical_rows: [], total_pages: 0 };
                }

                // 清除任务ID
                window.currentBatchTaskId = null;

                if (stopped) {
                  return {
                    success: true,
                    data: resultData,
                    stopped: true,
                    stopped_at_page: stopped_at_page,
                    taskId: currentTaskId
                  };
                } else {
                  return { success: true, data: resultData, taskId: currentTaskId };
                }
              } else if (data.type === 'error') {
                // 清除任务ID
                window.currentBatchTaskId = null;
                throw new Error(data.message);
              }
            } catch (parseError) {
              console.warn('解析进度数据失败: data:', line, 'Error:', parseError.message);
            }
          }
        }
      }
      
      // 如果没有收到结果，返回默认结果
      if (!hasResult) {
        return { success: true, data: { logical_rows: [], stopped_at_page: 0, total_pages: 0 } };
      }

      return { success: true };
    } catch (error) {
      console.error('批量OCR失败:', error);
      return { success: false, error: error.message };
    }
  },
  
  onOCRProgress: (callback) => {
    ipcRenderer.on('ocr-progress', (event, data) => callback(data));
  },
  
  onOCRResult: (callback) => {
    ipcRenderer.on('ocr-result', (event, data) => callback(data));
  },
  
  removeOCRListeners: () => {
    ipcRenderer.removeAllListeners('ocr-progress');
    ipcRenderer.removeAllListeners('ocr-result');
  },
  
  stopBatchOCR: async () => {
    try {
      // 从前端配置文件获取端口信息
      const configResponse = await fetch('./app-config.json');
      if (!configResponse.ok) {
        throw new Error('无法读取配置文件app-config.json');
      }
      
      const config = await configResponse.json();
      const port = config.ocr_server_port;
      
      if (!port) {
        throw new Error('配置文件中缺少OCR服务端口信息，请检查app-config.json文件中的ocr_server_port配置');
      }
      
      // 构建停止请求体
      let requestBody = {};
      const currentTaskId = window.currentBatchTaskId;
      
      if (currentTaskId) {
        requestBody = { task_id: currentTaskId };
      }
      
      // 调用后端停止接口
      const stopUrl = `http://127.0.0.1:${port}/api/recognize/stop`;
      const stopResponse = await fetch(stopUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      
      if (stopResponse.ok) {
        const result = await stopResponse.json();
        // 清除任务ID
        window.currentBatchTaskId = null;
        return { success: true, message: result.message || 'OCR处理已结束' };
      } else {
        throw new Error(`HTTP ${stopResponse.status}: ${stopResponse.statusText}`);
      }
    } catch (error) {
      console.error('❌ 结束OCR失败:', error);
      throw error;
    }
  },
  
  // 获取活跃任务列表
  getActiveTasks: async () => {
    try {
      // 从前端配置文件获取端口信息
      const configResponse = await fetch('./app-config.json');
      if (configResponse.ok) {
        const config = await configResponse.json();
        const port = config.ocr_server_port;
        
        if (port) {
          const tasksUrl = `http://127.0.0.1:${port}/api/recognize/tasks`;
          const tasksResponse = await fetch(tasksUrl, { method: 'GET' });
          
          if (tasksResponse.ok) {
            const result = await tasksResponse.json();
            return { success: true, data: result };
          } else {
            throw new Error(`HTTP ${tasksResponse.status}: ${tasksResponse.statusText}`);
          }
        }
      }
      
      return { success: false, error: '无法获取配置信息' };
    } catch (error) {
      console.error('❌ 获取活跃任务失败:', error);
      return { success: false, error: error.message };
    }
  },
  
  // OCR服务状态监听
  onOCRServerStatus: (callback) => {
    console.log('🎧 设置OCR服务状态监听器');
    ipcRenderer.on('ocr-server-status', (event, data) => {
      console.log('📩 preload收到OCR状态:', data);
      callback(data);
    });
  },
  
  removeOCRServerStatusListener: () => {
    console.log('🗑️ 移除OCR服务状态监听器');
    ipcRenderer.removeAllListeners('ocr-server-status');
  },
  
  // OCR服务管理
  getOCRServerStatus: () => {
    console.log('🔍 查询OCR服务状态');
    return ipcRenderer.invoke('get-ocr-server-status');
  },
  
  syncOCRServerStatus: () => {
    console.log('🔄 同步OCR服务状态');
    return ipcRenderer.invoke('sync-ocr-server-status');
  },
  
  restartOCRServer: () => {
    console.log('🔄 重启OCR服务');
    return ipcRenderer.invoke('restart-ocr-server');
  },
  
  // ==================== UI 缩放控制 ====================
  
  // 获取当前缩放比例
  getZoomFactor: () => {
    return ipcRenderer.invoke('get-zoom-factor');
  },
  
  // 设置缩放比例 (0.5 - 1.5)
  setZoomFactor: (factor) => {
    console.log('📐 设置UI缩放:', factor);
    return ipcRenderer.invoke('set-zoom-factor', factor);
  },
  
  // 获取屏幕信息
  getScreenInfo: () => {
    return ipcRenderer.invoke('get-screen-info');
  },
  
  // 重置为自动缩放
  resetZoomFactor: () => {
    console.log('📐 重置UI缩放为自动');
    return ipcRenderer.invoke('reset-zoom-factor');
  },
  
  // 添加测试方法
  test: () => {
    console.log('electronAPI测试成功！');
    return 'electronAPI工作正常';
  },
  
  // 氚云数据上传
  tritiumUpload: (data) => {
    console.log('🌐 调用tritiumUpload，数据:', data);
    return ipcRenderer.invoke('tritium-upload', data);
  },
  
  // 获取PDF书签/大纲
  getPDFBookmarks: (pdfPath) => {
    console.log('📚 获取PDF书签:', pdfPath);
    return ipcRenderer.invoke('get-pdf-bookmarks', pdfPath);
  },
  
  // 获取系统用户名
  getUserName: () => {
    return ipcRenderer.invoke('get-user-name');
  },
  
  // 获取桌面路径
  getDesktopPath: () => {
    return ipcRenderer.invoke('get-desktop-path');
  }
};

try {
  // 尝试使用contextBridge
  console.log('尝试使用contextBridge暴露API...');
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
  console.log('contextBridge.exposeInMainWorld 调用完成');
  console.log('===== Preload脚本加载成功！electronAPI已通过contextBridge暴露 =====');
  
} catch (error) {
  console.error('===== contextBridge失败，使用备用方案 =====', error);
  
  // 备用方案：禁用上下文隔离，直接设置到window
  console.log('将直接设置到window对象...');
  global.electronAPI = electronAPI;
  console.log('备用方案：设置到global成功');
}

// 注意：在preload脚本中无法直接验证window.electronAPI
// 因为contextBridge暴露的API只在主渲染进程上下文中可用
console.log('Preload脚本完成，API应该已在主世界中可用');
