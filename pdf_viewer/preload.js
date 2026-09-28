const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // PDF相关功能
  printToPDF: (options) => ipcRenderer.invoke('print-to-pdf', options),
  quickSavePDF: (options) => ipcRenderer.invoke('quick-save-pdf', options),
  saveFile: (filePath, data) => ipcRenderer.invoke('save-file', filePath, data),
  
  // PaddleOCR功能
  paddleOCR: (base64Image) => ipcRenderer.invoke('paddle-ocr', base64Image),
  checkPaddleOCR: () => ipcRenderer.invoke('check-paddle-ocr'),
  
  // 材料表OCR功能
  runMaterialOCR: (pdfPath, template, pdfData) => {
    ipcRenderer.send('run-material-ocr', { pdfPath, template, pdfData });
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
  
  // 批量OCR功能
  runBatchOCR: async (options) => {
    const { pdfFile, template, onProgress } = options;
    
    try {
      // 直接从app-config.json获取OCR服务器配置
      const configResponse = await fetch('./app-config.json');
      if (!configResponse.ok) {
        throw new Error('无法读取app-config.json配置文件');
      }
      const config = await configResponse.json();
      const port = config?.ocr_server_port;
      
      if (!port) {
        throw new Error('配置文件中缺少OCR服务端口信息，请检查app-config.json文件中的ocr_server_port配置');
      }
      
      const apiUrl = `http://127.0.0.1:${port}/api/recognize/batch`;
      
      // 后端统一做坐标规范化，这里不再转换坐标
      const convertedTemplate = { ...template };
      
      // 准备请求参数，匹配后端BatchProcessRequest格式
      const requestBody = {
        pdf_path: (typeof window.__lastOpenedPdfPath__ === 'string' && window.__lastOpenedPdfPath__) || pdfFile.path || pdfFile.name,
        template: convertedTemplate
      };
      
      // 发送POST请求到后端API
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      // 处理流式响应
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentTaskId = null; // 存储当前任务ID
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // 保留不完整的行
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'task_id') {
                // 保存任务ID
                currentTaskId = data.task_id;
                console.log('📋 收到任务ID:', currentTaskId);
                // 将任务ID存储到全局变量，供停止功能使用
                window.currentBatchTaskId = currentTaskId;
              } else if (data.type === 'progress' && onProgress) {
                // 转换后端进度格式到前端期望格式
                onProgress({
                  progress: data.percentage || 0,
                  status: data.phase || '处理中...',
                  currentPage: data.completed || 0,
                  totalPages: data.total || 0
                });
              } else if (data.type === 'result') {
                // 清除任务ID
                window.currentBatchTaskId = null;
                return { success: true, data: data.data, taskId: currentTaskId };
              } else if (data.type === 'error') {
                // 清除任务ID
                window.currentBatchTaskId = null;
                throw new Error(data.message);
              }
            } catch (parseError) {
              console.warn('解析进度数据失败:', parseError);
            }
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      console.error('批量OCR失败:', error);
      return { success: false, error: error.message };
    }
  },
  
  stopBatchOCR: async () => {
    try {
      // 调用后端停止接口
      const configResponse = await fetch('./app-config.json');
      if (configResponse.ok) {
        const config = await configResponse.json();
        const port = config.ocr_server_port;
        
        if (port) {
          // 构建停止请求体
          let requestBody = {};
          const currentTaskId = window.currentBatchTaskId;
          
          if (currentTaskId) {
            // 如果有当前任务ID，停止特定任务
            requestBody = { task_id: currentTaskId };
          }
          
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
          }
        }
      }
      
      return { success: true };
    } catch (error) {
      console.error('❌ 停止OCR失败:', error);
      return { success: false, error: error.message };
    }
  },
  
  // 获取活跃任务列表
  getActiveTasks: async () => {
    try {
      // 调用后端获取任务列表接口
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
    ipcRenderer.on('ocr-server-status', (event, data) => callback(data));
  },
  
  removeOCRServerStatusListener: () => {
    ipcRenderer.removeAllListeners('ocr-server-status');
  },
  
  // OCR服务管理
  getOCRServerStatus: () => ipcRenderer.invoke('get-ocr-server-status'),
  syncOCRServerStatus: () => ipcRenderer.invoke('sync-ocr-server-status'),
  restartOCRServer: () => ipcRenderer.invoke('restart-ocr-server'),
  
  // 配置管理
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // PDF路径管理
  getCurrentPdfPath: () => ipcRenderer.invoke('get-current-pdf-path'),
  setCurrentPdfPath: (filePath) => ipcRenderer.invoke('set-current-pdf-path', filePath),
  
  // 现有的其他API...
  // 如果有其他API，请在这里添加
});