const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// child_process模块已不再需要，所有OCR功能统一使用后端服务API
const os = require('os');



// 添加printToPDF功能
ipcMain.handle('print-to-pdf', async (event, options = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error('找不到窗口');
    }

    // 默认PDF选项
    const pdfOptions = {
      pageSize: 'A4',
      printBackground: true,
      landscape: false,
      margins: {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0
      },
      ...options
    };

    console.log('开始生成PDF，选项:', pdfOptions);

    // 生成PDF数据
    const data = await win.webContents.printToPDF(pdfOptions);

    // 显示保存对话框
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '保存PDF',
      defaultPath: `标注版-${new Date().toISOString().split('T')[0]}.pdf`,
      filters: [
        { name: 'PDF文件', extensions: ['pdf'] }
      ]
    });

    if (canceled || !filePath) {
      return { success: false, error: '用户取消保存' };
    }

    // 保存文件
    fs.writeFileSync(filePath, data);

    console.log('PDF保存成功:', filePath);

    return { 
      success: true, 
      filePath: filePath,
      message: 'PDF保存成功！'
    };

  } catch (error) {
    console.error('PDF生成失败:', error);
    return { 
      success: false, 
      error: error.message || '生成PDF时发生错误'
    };
  }
});

// 快速保存PDF（无需弹出对话框）
ipcMain.handle('quick-save-pdf', async (event, options = {}) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error('找不到窗口');
    }

    const pdfOptions = {
      pageSize: 'A4',
      printBackground: true,
      landscape: false,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      ...options
    };

    const data = await win.webContents.printToPDF(pdfOptions);

    // 保存到用户桌面
    const os = require('os');
    const desktopPath = path.join(os.homedir(), 'Desktop');
    const fileName = `标注版-${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
    const filePath = path.join(desktopPath, fileName);

    fs.writeFileSync(filePath, data);

    return { 
      success: true, 
      filePath: filePath,
      message: `PDF已保存到桌面: ${fileName}`
    };

  } catch (error) {
    console.error('快速保存失败:', error);
    return { 
      success: false, 
      error: error.message || '快速保存失败'
    };
  }
});

// 保存文件到指定路径
ipcMain.handle('save-file', async (event, filePath, data) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      throw new Error('找不到窗口');
    }

    // 将数组转换为Buffer
    const buffer = Buffer.from(data);
    
    // 首先尝试直接保存到指定路径
    try {
      // 确保目录存在
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // 检查文件是否被占用或没有写权限
      try {
        // 尝试写入文件
        fs.writeFileSync(filePath, buffer);
        
        console.log('文件保存成功:', filePath);
        return { 
          success: true, 
          savedPath: filePath,
          message: '文件保存成功！'
        };
      } catch (writeError) {
        console.warn('无法写入原文件:', writeError.message);
        // 如果无法写入，弹出另存为对话框
        throw writeError;
      }
    } catch (error) {
      console.log('原文件保存失败，提示用户另存为:', error.message);
      
      // 弹出另存为对话框
      const { canceled, filePath: newFilePath } = await dialog.showSaveDialog(win, {
        title: '另存为',
        defaultPath: filePath,
        filters: [
          { name: 'PDF文件', extensions: ['pdf'] }
        ]
      });

      if (canceled || !newFilePath) {
        return { 
          success: false, 
          error: '用户取消保存',
          wasCanceled: true
        };
      }

      // 保存到新路径
      fs.writeFileSync(newFilePath, buffer);
      
      console.log('文件另存为成功:', newFilePath);
      return { 
        success: true, 
        savedPath: newFilePath,
        wasSavedAs: true,
        message: `文件已另存为: ${path.basename(newFilePath)}`
      };
    }

  } catch (error) {
    console.error('文件保存失败:', error);
    return { 
      success: false, 
      error: error.message || '保存文件时发生错误'
    };
  }
});

// OCR功能统一使用后端服务，移除直接PaddleOCR调用
// 检查OCR服务是否可用（通过后端服务）
ipcMain.handle('check-paddle-ocr', async () => {
  try {
    const http = require('http');
    const options = {
      hostname: '127.0.0.1',
      port: 8765, // 从配置文件读取
      path: '/api/health',
      method: 'GET',
      timeout: 3000
    };
    
    return new Promise((resolve) => {
      const req = http.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve({ available: true });
        } else {
          resolve({ available: false, error: 'OCR服务不可用' });
        }
      });
      
      req.on('error', () => {
        resolve({ available: false, error: 'OCR服务连接失败' });
      });
      
      req.on('timeout', () => {
        req.destroy();
        resolve({ available: false, error: 'OCR服务连接超时' });
      });
      
      req.end();
    });
  } catch (error) {
    return { available: false, error: error.message };
  }
});

// OCR处理统一使用后端服务
ipcMain.handle('paddle-ocr', async (event, base64Image) => {
  try {
    const http = require('http');
    const querystring = require('querystring');
    
    // 构建请求数据
    const postData = JSON.stringify({
      image_data: base64Image,
      confidence_threshold: 0.4
    });
    
    const options = {
      hostname: '127.0.0.1',
      port: 8765,
      path: '/api/recognize/image',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    };
    
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const result = JSON.parse(data);
              resolve(result);
            } else {
              reject(new Error(`OCR服务返回错误: ${res.statusCode} - ${data}`));
            }
          } catch (error) {
            reject(new Error(`解析OCR结果失败: ${error.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`OCR服务连接失败: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OCR服务请求超时'));
      });
      
      req.write(postData);
      req.end();
    });
  } catch (error) {
    throw new Error(`OCR处理失败: ${error.message}`);
  }
});

// 材料表OCR处理 - 统一使用后端服务API
ipcMain.on('run-material-ocr', async (event, args) => {
  const { pdfPath, template, pdfData } = args;
  
  let actualPdfPath = pdfPath;
  let tempPdfPath = null;
  
  try {
    // 如果pdfPath是blob URL，需要使用pdfData创建临时文件
    if (pdfPath && pdfPath.startsWith('blob:')) {
      if (!pdfData) {
        event.reply('ocr-result', { error: 'blob URL需要提供PDF数据' });
        return;
      }
      const tempDir = os.tmpdir();
      tempPdfPath = path.join(tempDir, `ocr_pdf_${Date.now()}.pdf`);
      const pdfBuffer = Buffer.from(pdfData, 'base64');
      fs.writeFileSync(tempPdfPath, pdfBuffer);
      actualPdfPath = tempPdfPath;
    }
    
    // 处理图像数据模板
    let processedTemplate = template;
    if (template && template.image_data) {
      // 对于图像数据，直接传递给后端服务处理
      processedTemplate = { ...template };
    }

    console.log('🔍 使用后端OCR服务处理');
    console.log('🔍 PDF文件路径:', actualPdfPath);
    console.log('🔍 模板数据:', JSON.stringify(processedTemplate));
    
    // 调用后端OCR服务API
    const http = require('http');
    const postData = JSON.stringify({
      pdf_path: actualPdfPath,
      template: processedTemplate
    });
    
    const options = {
      hostname: '127.0.0.1',
      port: 8765,
      path: '/api/recognize/batch',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 300000 // 5分钟超时
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      
      // 处理流式响应（Server-Sent Events）
      res.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        data += chunkStr;
        
        // 解析SSE格式的进度更新
        const lines = chunkStr.split('\n');
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.substring(6));
              if (eventData.type === 'progress') {
                event.reply('ocr-progress', eventData.data);
              } else if (eventData.type === 'result') {
                event.reply('ocr-result', eventData.data);
              } else if (eventData.type === 'error') {
                event.reply('ocr-result', { error: eventData.message });
              }
            } catch (e) {
              // 忽略JSON解析错误
            }
          }
        });
      });
      
      res.on('end', () => {
        // 清理临时文件
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
          try {
            fs.unlinkSync(tempPdfPath);
          } catch (error) {
            console.error('清理临时PDF文件失败:', error);
          }
        }
        
        // 如果没有通过SSE发送结果，尝试解析完整响应
        if (res.statusCode !== 200) {
          event.reply('ocr-result', { error: `OCR服务返回错误: ${res.statusCode}` });
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('OCR服务连接失败:', error);
      event.reply('ocr-result', { error: `OCR服务连接失败: ${error.message}` });
      
      // 清理临时文件
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try {
          fs.unlinkSync(tempPdfPath);
        } catch (cleanupError) {
          console.error('清理临时PDF文件失败:', cleanupError);
        }
      }
    });
    
    req.on('timeout', () => {
      req.destroy();
      event.reply('ocr-result', { error: 'OCR服务请求超时' });
      
      // 清理临时文件
      if (tempPdfPath && fs.existsSync(tempPdfPath)) {
        try {
          fs.unlinkSync(tempPdfPath);
        } catch (cleanupError) {
          console.error('清理临时PDF文件失败:', cleanupError);
        }
      }
    });
    
    req.write(postData);
    req.end();
    
  } catch (error) {
    console.error('材料表OCR处理失败:', error);
    event.reply('ocr-result', { error: '材料表OCR处理失败: ' + error.message });
    
    // 清理临时文件
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      try {
        fs.unlinkSync(tempPdfPath);
      } catch (cleanupError) {
        console.error('清理临时PDF文件失败:', cleanupError);
      }
    }
  }
});

// 配置管理 - 读取配置
ipcMain.handle('get-config', async () => {
  try {
    let configPath;
    
    // 判断是否为打包后的环境
    if (app.isPackaged) {
      // 打包后：配置文件在exe同级目录
      configPath = path.join(process.resourcesPath, '../settings.json');
      // 如果上述路径不存在，尝试exe同级目录
      if (!fs.existsSync(configPath)) {
        configPath = path.join(path.dirname(process.execPath), 'settings.json');
      }
    } else {
      // 开发环境：使用相对路径
      configPath = path.join(__dirname, 'python/table/settings.json');
    }
    
    if (!fs.existsSync(configPath)) {
      return { error: 'NOT_FOUND', path: configPath };
    }
    const data = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
    return (typeof data === 'object' ? data : {});
  } catch (e) {
    return { error: String(e) };
  }
});

// 配置管理 - 保存配置
ipcMain.handle('save-config', async (event, config) => {
  try {
    const defaults = { confidence_threshold: 0.4 };
    const merged = { ...defaults, ...(config || {}) };
    
    let configPath;
    // 判断是否为打包后的环境
    if (app.isPackaged) {
      // 打包后：配置文件在exe同级目录
      configPath = path.join(process.resourcesPath, '../settings.json');
      // 如果上述路径不存在，尝试exe同级目录
      if (!fs.existsSync(path.dirname(configPath))) {
        configPath = path.join(path.dirname(process.execPath), 'settings.json');
      }
    } else {
      // 开发环境：使用相对路径
      configPath = path.join(__dirname, 'python/table/settings.json');
    }
    
    // 确保目录存在
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    await fs.promises.writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log('[save-config] ->', configPath);
    return { success: true };
  } catch (e) {
    return { error: String(e) };
  }
});

// 现有的其他IPC处理器...