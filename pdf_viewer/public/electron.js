const { app, BrowserWindow, Menu, dialog, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const os = require('os');

// UI缩放相关
let currentZoomFactor = 1.0;
// 强制使用开发模式检测
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev') || require('./electron-is-dev') || process.env.npm_lifecycle_event === 'electron-dev';

let mainWindow;

// 全局变量：保存当前打开的PDF文件路径
let currentPdfPath = null;

// 配置文件路径
const userDataPath = app.getPath('userData');
const configFilePath = path.join(userDataPath, 'app-settings.json');

// 保存应用设置
function saveAppSettings() {
  try {
    const settings = {
      lastOpenedPdfPath: currentPdfPath,
      lastSavedTime: new Date().toISOString(),
      uiZoomFactor: currentZoomFactor  // 保存UI缩放比例
    };
    fs.writeFileSync(configFilePath, JSON.stringify(settings, null, 2), 'utf8');
    console.log('📁 已保存应用设置:', settings);
  } catch (error) {
    console.error('❌ 保存应用设置失败:', error);
  }
}

// 加载应用设置
function loadAppSettings() {
  try {
    if (fs.existsSync(configFilePath)) {
      const data = fs.readFileSync(configFilePath, 'utf8');
      const settings = JSON.parse(data);
      console.log('📁 已加载应用设置:', settings);
      return settings;
    }
  } catch (error) {
    console.error('❌ 加载应用设置失败:', error);
  }
  return null;
}

// 计算适合当前屏幕的缩放比例
function calculateAutoZoomFactor() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const scaleFactor = primaryDisplay.scaleFactor;
    
    console.log(`📺 屏幕信息: ${width}x${height}, DPI缩放: ${scaleFactor}`);
    
    // 基准：1920x1080 分辨率，100% DPI 缩放时使用 1.0
    // 根据实际分辨率和DPI调整
    let autoZoom = 1.0;
    
    // 如果是小分辨率屏幕（如 1366x768），适当缩小
    if (width < 1600) {
      autoZoom = 0.85;
    } else if (width < 1400) {
      autoZoom = 0.75;
    }
    
    // 如果是高DPI屏幕（如 125%, 150%），适当调整
    if (scaleFactor > 1.25) {
      autoZoom = autoZoom * 0.9;
    }
    
    // 如果是大分辨率屏幕（如 2560x1440 或 4K），可以适当放大
    if (width >= 2560 && scaleFactor <= 1) {
      autoZoom = 1.1;
    }
    
    console.log(`📐 自动计算的缩放比例: ${autoZoom}`);
    return autoZoom;
  } catch (error) {
    console.error('❌ 计算缩放比例失败:', error);
    return 1.0;
  }
}

// 加载UI缩放设置
function loadZoomFactor() {
  const settings = loadAppSettings();
  if (settings && settings.uiZoomFactor) {
    currentZoomFactor = settings.uiZoomFactor;
    console.log(`📐 已加载用户缩放设置: ${currentZoomFactor}`);
  } else {
    // 首次使用，自动计算合适的缩放比例
    currentZoomFactor = calculateAutoZoomFactor();
    console.log(`📐 首次使用，自动缩放: ${currentZoomFactor}`);
  }
  return currentZoomFactor;
}

// 加载上次打开的PDF文件
function loadLastOpenedPDF() {
  try {
    const settings = loadAppSettings();
    if (settings && settings.lastOpenedPdfPath) {
      const filePath = settings.lastOpenedPdfPath;
      console.log('🔄 尝试加载上次打开的PDF:', filePath);
      
      // 检查文件是否仍然存在
      if (fs.existsSync(filePath)) {
        // 读取文件内容并发送给渲染进程
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        console.log('✅ 成功加载上次的PDF文件:', fileName);
        
        // 更新当前PDF路径
        currentPdfPath = filePath;
        
        // 发送给前端
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('open-pdf', {
            fileName: fileName,
            buffer: fileBuffer,
            filePath: filePath
          });
        }
      } else {
        console.warn('⚠️ 上次打开的PDF文件不存在:', filePath);
        // 清理无效的路径
        currentPdfPath = null;
        saveAppSettings();
      }
    } else {
      console.log('📝 没有找到上次打开的PDF文件记录');
    }
  } catch (error) {
    console.error('❌ 加载上次PDF文件失败:', error);
  }
}

// OCR服务管理
let ocrServerProcess = null;
let ocrServerPort = null; // 从配置文件读取
let ocrBackendMode = 'python';
let ocrBackendExePath = '';
let isAppQuitting = false;
let ocrServerStopPromise = null;
let isOcrServerStarting = false;
let ocrServerStartupAttempts = 0;
const MAX_STARTUP_ATTEMPTS = 3;
const STARTUP_TIMEOUT = 30000; // 30秒超时

// 读取OCR服务端口配置
function loadOcrPortConfig() {
  try {
    let configPath;
    
    // 判断是否为打包后的环境
    if (app.isPackaged) {
      // 打包后：优先查找外部配置文件（extraFiles）
      configPath = path.join(path.dirname(process.execPath), 'app-config.json');
      // 如果外部配置文件不存在，尝试resources目录中的配置文件
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.resourcesPath, 'app-config.json');
      }
      if (!fs.existsSync(configPath)) {
        configPath = path.join(process.resourcesPath, 'app/public/app-config.json');
      }
      if (!fs.existsSync(configPath)) {
        configPath = path.join(path.dirname(process.execPath), 'resources/app/public/app-config.json');
      }
    } else {
      // 开发环境：使用相对路径
      configPath = path.join(__dirname, 'app-config.json');
    }
    
    console.log(`[OCR服务] 尝试读取配置文件: ${configPath}`);
    
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.ocr_server_port) {
        ocrServerPort = config.ocr_server_port;
        console.log(`[OCR服务] 从配置文件读取端口: ${ocrServerPort}`);
      } else {
        console.error('[OCR服务] 配置文件中缺少OCR端口信息');
        return false;
      }
      // 读取后端启动模式
      if (typeof config.ocr_backend === 'string') {
        ocrBackendMode = config.ocr_backend.toLowerCase();
      }
      if (typeof config.ocr_backend_exe_path === 'string') {
        if (app.isPackaged) {
          // 打包环境：处理相对路径，优先查找 resources 目录
          if (path.isAbsolute(config.ocr_backend_exe_path)) {
            // 如果配置中是绝对路径，直接使用
            ocrBackendExePath = config.ocr_backend_exe_path;
          } else {
            // 如果配置中是相对路径，尝试多个可能的基础目录
            const basePaths = [
              process.resourcesPath, // resources 目录
              path.dirname(process.execPath), // 可执行文件目录
              path.join(process.resourcesPath, 'app') // resources/app 目录
            ];
            
            let foundPath = null;
            for (const basePath of basePaths) {
              const fullPath = path.join(basePath, config.ocr_backend_exe_path);
              if (fs.existsSync(fullPath)) {
                foundPath = fullPath;
                break;
              }
            }
            
            ocrBackendExePath = foundPath || path.join(process.resourcesPath, config.ocr_backend_exe_path);
          }
        } else {
          // 开发环境：处理相对路径，基于项目根目录
          if (config.ocr_backend_exe_path && !path.isAbsolute(config.ocr_backend_exe_path)) {
            // 假设项目根目录是 __dirname/.. (public的上一级)
            ocrBackendExePath = path.resolve(path.join(__dirname, '..'), config.ocr_backend_exe_path);
          } else {
            ocrBackendExePath = config.ocr_backend_exe_path;
          }
        }
      }
      console.log(`[OCR服务] 启动模式: ${ocrBackendMode}${ocrBackendMode==='exe' ? ' -> '+ocrBackendExePath : ''}`);
      return true;
    } else {
      console.error(`[OCR服务] 配置文件不存在: ${configPath}`);
      return false;
    }
  } catch (error) {
    console.error('[OCR服务] 读取配置文件失败:', error.message);
    return false;
  }
}

// 检查OCR服务是否运行
function checkOcrServerHealth() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get(`http://127.0.0.1:${ocrServerPort}/health`, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve(false);
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const healthData = JSON.parse(data);
          // 检查ready字段和status字段
          const isHealthy = healthData.ready === true;
          resolve(isHealthy);
        } catch (error) {
          console.error('[OCR健康检查] 解析响应失败:', error);
          resolve(false);
        }
      });
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// 启动OCR服务
function startOcrServer(forceRestart = false) {
  const callId = Date.now();
  console.log(`[OCR服务] startOcrServer 调用 ${callId}, forceRestart=${forceRestart}, isOcrServerStarting=${isOcrServerStarting}`);
  
  // 如果不是强制重启且服务正在运行，直接返回成功
  if (!forceRestart && !isOcrServerStarting) {
    console.log(`[OCR服务] ${callId} 检查健康状态`);
    return checkOcrServerHealth().then(isHealthy => {
      if (isHealthy) {
        console.log(`[OCR服务] ${callId} 服务已在运行`);
        return true;
      }
      // 如果健康检查失败，继续启动流程（跳过健康检查）
      console.log(`[OCR服务] ${callId} 服务未运行，开始启动服务`);
      return startOcrServerInternal();
    });
  }
  
  // 如果是强制重启或者正在启动，直接进入启动流程
  console.log(`[OCR服务] ${callId} 直接进入启动流程`);
  return startOcrServerInternal(forceRestart);
}

function startOcrServerInternal(forceRestart = false) {
  const internalCallId = Date.now();
  console.log(`[OCR服务] startOcrServerInternal 调用 ${internalCallId}, forceRestart=${forceRestart}, isOcrServerStarting=${isOcrServerStarting}`);
  
  if (isOcrServerStarting) {
    console.log(`[OCR服务] ${internalCallId} 服务正在启动中，等待启动完成...`);
    // 如果正在启动，返回一个等待启动完成的Promise
    return new Promise(async (resolve) => {
      const checkStartup = setInterval(async () => {
        if (!isOcrServerStarting) {
          clearInterval(checkStartup);
          // 通过健康检查来判断启动是否成功
          const isHealthy = await checkOcrServerHealth();
          resolve(isHealthy);
        }
      }, 500);
      
      // 设置超时，避免无限等待
      setTimeout(() => {
        clearInterval(checkStartup);
        resolve(false);
      }, STARTUP_TIMEOUT);
    });
  }

  return new Promise(async (resolve) => {
    console.log(`[OCR服务] ${internalCallId} 开始新的启动流程`);
    isOcrServerStarting = true;
    ocrServerStartupAttempts++;
    
    console.log(`[OCR服务] ${internalCallId} 启动尝试 ${ocrServerStartupAttempts}/${MAX_STARTUP_ATTEMPTS}`);
    
    // 启动前先检查端口是否被占用
    console.log('[OCR服务] 检查端口状态...');
    const isPortOccupied = await checkOcrServerHealth();
    if (isPortOccupied) {
      if (!forceRestart) {
        console.log('[OCR服务] 检测到现有服务正在运行且健康，直接复用');
        isOcrServerStarting = false;
        resolve(true);
        return;
      } else {
        console.log('[OCR服务] 强制重启模式，关闭现有服务...');
        try {
          // 尝试通过API优雅关闭现有服务
          const http = require('http');
          const shutdownReq = http.request({
            hostname: '127.0.0.1',
            port: ocrServerPort,
            path: '/api/shutdown',
            method: 'POST',
            timeout: 3000
          }, (res) => {
            console.log('[OCR服务] 现有服务已通过API关闭');
          });
          
          shutdownReq.on('error', () => {
            console.log('[OCR服务] API关闭失败，将继续启动流程');
          });
          
          shutdownReq.end();
          
          // 等待2秒让现有服务关闭
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.log('[OCR服务] 清理现有服务时出错，继续启动流程:', error.message);
        }
      }
    }
    
    // 选择后端启动方式：按配置优先（exe 或 python）
    let backendCmd = null;
    let backendArgs = [];
    let backendCwd = null;

    if (ocrBackendMode === 'exe' && ocrBackendExePath) {
      if (fs.existsSync(ocrBackendExePath)) {
        backendCmd = ocrBackendExePath;
        backendArgs = [];
        backendCwd = path.dirname(ocrBackendExePath);
        console.log(`[OCR服务] 按配置使用 EXE 启动后端: ${ocrBackendExePath}`);
      } else {
        console.error(`[OCR服务] 配置的EXE文件不存在: ${ocrBackendExePath}`);
        console.error(`[OCR服务] 请检查配置文件中的 ocr_backend_exe_path 路径是否正确`);
        
        // 显示错误对话框给用户
        if (mainWindow) {
          console.log('OCR服务启动被跳过：文件不存在且为非必须组件');
          // dialog.showErrorBox(
          //   'OCR服务启动失败',
          //   `配置的EXE文件不存在:\n${ocrBackendExePath}\n\n请检查配置文件中的路径是否正确，或重新构建后端程序。`
          // );
        }
        
        isOcrServerStarting = false;
        resolve(false);
        return;
      }
    } else {
      // 回退策略：打包时尝试内置 exe；否则使用 python 脚本
      if (app.isPackaged) {
        const exeCandidates = [
          path.join(path.dirname(process.execPath), 'ocr_server.exe'),
          path.join(path.dirname(process.execPath), 'ocr_server', 'ocr_server.exe'),
          path.join(path.dirname(process.execPath), 'python', 'ocr_server.exe'),
          path.join(process.resourcesPath, 'ocr_server.exe'),
          path.join(process.resourcesPath, 'ocr_server', 'ocr_server.exe'),
          path.join(process.resourcesPath, 'python', 'ocr_server.exe')
        ];
        const exePath = exeCandidates.find(p => fs.existsSync(p));
        if (exePath) {
          backendCmd = exePath;
          backendArgs = [];
          backendCwd = path.dirname(exePath);
          console.log(`[OCR服务] 使用已打包的后端: ${exePath}`);
        }
      }
      if (!backendCmd) {
        // python 脚本
        let pythonPath = app.isPackaged
          ? (fs.existsSync(path.join(process.resourcesPath, 'python', 'ocr_server.py'))
              ? path.join(process.resourcesPath, 'python', 'ocr_server.py')
              : path.join(path.dirname(process.execPath), 'python', 'ocr_server.py'))
          : path.join(__dirname, '../ocr_server/python/ocr_server.py');
        if (!fs.existsSync(pythonPath)) {
          console.error(`[OCR服务] 未找到后端可执行文件或脚本: ${pythonPath}`);
          isOcrServerStarting = false;
          resolve(false);
          return;
        }
        
        // 优先使用虚拟环境中的 Python
        const pythonDir = path.dirname(pythonPath);
        const venvPython = path.join(pythonDir, '.venv', 'Scripts', 'python.exe');
        
        if (fs.existsSync(venvPython)) {
          backendCmd = venvPython;
          console.log(`[OCR服务] 使用虚拟环境 Python: ${venvPython}`);
        } else {
        backendCmd = 'python';
          console.log(`[OCR服务] 使用系统 Python (虚拟环境未找到)`);
        }
        
        backendArgs = [pythonPath];
        backendCwd = path.dirname(pythonPath);
        console.log(`[OCR服务] 启动脚本: ${pythonPath}`);
      }
    }

    // 启动后端进程
    const serverSpawnOptions = {
      cwd: backendCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,  // 隐藏控制台窗口
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    };

    // Windows下添加额外配置来彻底隐藏控制台窗口
    if (process.platform === 'win32') {
      serverSpawnOptions.windowsVerbatimArguments = false;
      serverSpawnOptions.detached = false;
      // 添加更多Windows特定选项来防止控制台闪烁
      serverSpawnOptions.shell = false;
      serverSpawnOptions.windowsHide = true;
      // 设置创建标志来完全隐藏窗口
      serverSpawnOptions.creationFlags = 0x08000000; // CREATE_NO_WINDOW
    }
    
    ocrServerProcess = spawn(backendCmd, backendArgs, serverSpawnOptions);
    
    // 设置启动超时
    const timeoutId = Date.now(); // 添加唯一ID用于调试
    console.log(`[OCR服务] 设置启动超时器 ${timeoutId}，${STARTUP_TIMEOUT}ms`);
    let startupTimeout = setTimeout(() => {
      // 只有在仍在启动状态时才报告超时
      if (isOcrServerStarting) {
        console.error(`[OCR服务] 启动超时器 ${timeoutId} 触发 - 启动超时`);
        if (healthCheckInterval) {
          clearInterval(healthCheckInterval);
          healthCheckInterval = null;
        }
        isOcrServerStarting = false;
        startupTimeout = null;
        resolve(false);
      } else {
        console.log(`[OCR服务] 启动超时器 ${timeoutId} 触发但服务已非启动状态，忽略`);
      }
    }, STARTUP_TIMEOUT);
    
    // 监听服务输出
     ocrServerProcess.stdout.on('data', (data) => {
       const output = data.toString();
       console.log('[OCR服务输出]', output.trim());
     });
     
     // 定期检查健康状态来判断启动是否成功
     let healthCheckInterval = setInterval(async () => {
       try {
         const isHealthy = await checkOcrServerHealth();
         if (isHealthy) {
           // 清理所有定时器
           if (startupTimeout) {
             console.log(`[OCR服务] 清理启动超时器 ${timeoutId}`);
             clearTimeout(startupTimeout);
             startupTimeout = null;
           }
           if (healthCheckInterval) {
             clearInterval(healthCheckInterval);
             healthCheckInterval = null;
           }
           isOcrServerStarting = false;
           console.log('[OCR服务] 启动成功 - 健康检查通过');
           resolve(true);
           return;
         }
       } catch (error) {
         // 健康检查失败，继续等待
       }
     }, 2000); // 每2秒检查一次
    
    ocrServerProcess.stderr.on('data', (data) => {
      const message = data.toString().trim();
      // FastAPI/Uvicorn会将INFO级别的日志输出到stderr，需要区分真正的错误
      if (message.includes('ERROR') || message.includes('CRITICAL') || message.includes('Exception') || message.includes('Traceback')) {
        console.error('[OCR服务错误]', message);
      } else {
        // INFO级别的日志不应该标记为错误
        console.log('[OCR服务]', message);
      }
    });
    
    ocrServerProcess.on('close', (code) => {
      console.log(`[OCR服务] 进程退出，代码: ${code}`);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      if (startupTimeout) {
        console.log(`[OCR服务] 进程退出时清理启动超时器 ${timeoutId}`);
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
      ocrServerProcess = null;
      isOcrServerStarting = false;
      
      // 如果是意外退出且未达到最大重试次数，尝试重启（应用正在退出时不重启）
      if (!isAppQuitting && code !== 0 && ocrServerStartupAttempts < MAX_STARTUP_ATTEMPTS) {
        console.log('[OCR服务] 检测到意外退出，尝试重启...');
        setTimeout(() => startOcrServer(), 3000);
      } else if (isOcrServerStarting) {
        // 如果正在启动过程中进程退出，标记为启动失败
        resolve(false);
      }
    });
    
    ocrServerProcess.on('error', (error) => {
      console.error('[OCR服务] 启动失败:', error.message);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      if (startupTimeout) {
        console.log(`[OCR服务] 进程错误时清理启动超时器 ${timeoutId}`);
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
      isOcrServerStarting = false;
      ocrServerProcess = null;
      resolve(false);
    });
  });
}

// 关闭OCR服务
// 尝试通过API关闭OCR服务
function attemptApiShutdown() {
  return new Promise((resolve) => {
    try {
      console.log('[OCR服务] 尝试软停：发送关闭请求');
      const http = require('http');
      const req = http.request({
        hostname: '127.0.0.1',
        port: ocrServerPort,
        path: '/api/shutdown',
        method: 'POST',
        timeout: 3000
      }, (res) => {
        console.log('[OCR服务] 软停请求已发送，状态码:', res.statusCode);
        resolve();
      });
      
      req.on('error', (err) => {
        console.log('[OCR服务] 软停请求失败:', err.message);
        resolve();
      });
      
      req.on('timeout', () => {
        console.log('[OCR服务] 软停请求超时');
        req.destroy();
        resolve();
      });
      
      req.end();
    } catch (e) {
      console.log('[OCR服务] 软停请求异常:', e.message);
      resolve();
    }
  });
}

function stopOcrServer() {
  if (ocrServerStopPromise) {
    return ocrServerStopPromise;
  }
  
  ocrServerStopPromise = new Promise(async (resolve) => {
    // 首先检查服务是否真的在运行
    const isHealthy = await checkOcrServerHealth();
    
    if (!isHealthy) {
      console.log('[OCR服务] 健康检查显示服务未运行，无需关闭');
      ocrServerProcess = null; // 清理可能的无效进程引用
      resolve();
      return;
    }
    
    console.log('[OCR服务] 检测到服务正在运行，开始关闭流程');
    
    if (!ocrServerProcess) {
      console.log('[OCR服务] 无进程引用，仅通过API关闭服务');
      await attemptApiShutdown();
      
      // 等待一段时间后再次检查服务是否真的关闭了
      setTimeout(async () => {
        const isStillHealthy = await checkOcrServerHealth();
        if (isStillHealthy) {
          console.log('[OCR服务] API关闭失败，服务仍在运行，尝试强制终止');
          // 尝试通过进程名强制终止
          try {
            if (process.platform === 'win32') {
              exec('taskkill /f /im ocr_server.exe', (error, stdout, stderr) => {
                if (error) {
                  console.error('[OCR服务] 强制终止失败:', error.message);
                } else {
                  console.log('[OCR服务] 强制终止成功:', stdout);
                }
                resolve();
              });
            } else {
              exec('pkill -f ocr_server', (error, stdout, stderr) => {
                if (error) {
                  console.error('[OCR服务] 强制终止失败:', error.message);
                } else {
                  console.log('[OCR服务] 强制终止成功');
                }
                resolve();
              });
            }
          } catch (e) {
            console.error('[OCR服务] 强制终止异常:', e.message);
            resolve();
          }
        } else {
          console.log('[OCR服务] API关闭成功，服务已停止');
          resolve();
        }
      }, 2000); // 等待2秒让服务有时间关闭
      return;
    }

    console.log('[OCR服务] 正在关闭服务...');
    const serverPid = ocrServerProcess.pid;
    let isResolved = false;

    // 软停：尝试调用 /api/shutdown
    await attemptApiShutdown();

    // 等待进程自行退出，最多等待5秒
    const maxWaitTime = 5000;
    const checkInterval = 200;
    const startTime = Date.now();
    
    const waitInterval = setInterval(() => {
      if (!ocrServerProcess || isResolved) {
        clearInterval(waitInterval);
        if (!isResolved) {
          console.log('[OCR服务] 服务已正常关闭');
          isResolved = true;
          resolve();
        }
        return;
      }
      
      if (Date.now() - startTime > maxWaitTime) {
        clearInterval(waitInterval);
        console.log('[OCR服务] 软停超时，执行硬停');
        
        // 硬停：强制终止进程
        try {
          if (process.platform === 'win32') {
            // Windows: 使用taskkill强制终止进程树
            console.log(`[OCR服务] 执行taskkill /pid ${serverPid} /T /F`);
            exec(`taskkill /pid ${serverPid} /T /F`, (error, stdout, stderr) => {
              if (error) {
                console.error('[OCR服务] taskkill执行失败:', error.message);
              } else {
                console.log('[OCR服务] taskkill执行成功:', stdout);
              }
            });
          } else {
            // Unix系统: 使用SIGKILL
            console.log(`[OCR服务] 发送SIGKILL信号到进程 ${serverPid}`);
            ocrServerProcess.kill('SIGKILL');
          }
        } catch (e) {
          console.error('[OCR服务] 硬停执行失败:', e.message);
        }
        
        // 等待额外2秒确保进程被终止
        setTimeout(() => {
          if (!isResolved) {
            console.log('[OCR服务] 强制关闭完成');
            isResolved = true;
            resolve();
          }
        }, 2000);
      }
    }, checkInterval);

    // 监听进程关闭事件
    if (ocrServerProcess) {
      ocrServerProcess.on('close', (code) => {
        console.log(`[OCR服务] 进程已退出，退出码: ${code}`);
        try { clearInterval(waitInterval); } catch(e) {}
        if (!isResolved) {
          isResolved = true;
          resolve();
        }
      });
    }
  });
  
  return ocrServerStopPromise;
}

function createWindow() {
  // 创建浏览器窗口
  const preloadPath = path.join(__dirname, 'preload.js');
  
  console.log('Preload脚本路径:', preloadPath);
  console.log('文件是否存在:', require('fs').existsSync(preloadPath));
  
  // 加载UI缩放设置
  const zoomFactor = loadZoomFactor();
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'PDF单线图焊口预制标注工具',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: preloadPath,
      zoomFactor: zoomFactor  // 使用自适应或用户设置的缩放比例
    },
    show: false,
    titleBarStyle: 'default',
    icon: path.join(__dirname, '../logo1.png')
  });

  // 加载应用
  let startUrl;
  const buildPath = path.join(__dirname, '../build/index.html');
  const buildExists = require('fs').existsSync(buildPath);
  
  // 如果是开发模式或者build文件不存在，使用开发服务器
  if (isDev || !buildExists) {
    startUrl = 'http://localhost:3004';
    console.log('使用开发服务器');
  } else {
    startUrl = `file://${buildPath}`;
    console.log('使用生产build');
  }
  
  console.log('isDev:', isDev);
  console.log('buildExists:', buildExists);
  console.log('加载URL:', startUrl);
  
  mainWindow.loadURL(startUrl);

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    
    // 开发模式下打开开发者工具
    if (isDev) {
      mainWindow.webContents.openDevTools();
    }
    
    // 延迟检查OCR服务状态并同步给前端
    setTimeout(async () => {
      try {
        const isHealthy = await checkOcrServerHealth();
        const statusData = {
          status: isHealthy ? 'ready' : 'starting',
          message: isHealthy ? 'OCR服务已就绪' : '正在启动OCR服务...'
        };
        console.log('[OCR服务] 窗口显示时检查状态:', statusData);
        sendOCRStatusToFrontend(statusData.status, statusData.message);
      } catch (error) {
        console.error('[OCR服务] 窗口显示时状态检查失败:', error);
      }
      
      // 加载上次打开的PDF文件
      loadLastOpenedPDF();
    }, 1500);
  });

  // 窗口关闭时
  mainWindow.on('closed', () => {
    // 保存应用设置
    saveAppSettings();
    mainWindow = null;
  });

  // 创建菜单
  createMenu();
}

function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开PDF',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            dialog.showOpenDialog(mainWindow, {
              properties: ['openFile'],
              filters: [
                { name: 'PDF文件', extensions: ['pdf'] }
              ]
            }).then(result => {
              if (!result.canceled && result.filePaths.length > 0) {
                const filePath = result.filePaths[0];
                console.log('Electron: 选择的PDF文件:', filePath);
                
                // 读取文件内容并发送给渲染进程
                const fs = require('fs');
                try {
                  const fileBuffer = fs.readFileSync(filePath);
                  const fileName = path.basename(filePath);
                  console.log('Electron: 读取文件成功，大小:', fileBuffer.length, '字节');
                  
                  // 保存当前PDF路径到全局变量
                  currentPdfPath = filePath;
                  
                  mainWindow.webContents.send('open-pdf', {
                    fileName: fileName,
                    buffer: fileBuffer,
                    filePath: filePath  // 同时发送文件路径
                  });
                } catch (error) {
                  console.error('Electron: 读取文件失败:', error);
                  mainWindow.webContents.send('open-pdf-error', error.message);
                }
              } else {
                console.log('Electron: 用户取消了文件选择');
              }
            });
          }
        },
        { type: 'separator' },
        {
          label: '退出',
          // accelerator: null,  // 🚫 禁用快捷键，避免误触
          click: async () => {
            // 直接处理退出逻辑，避免递归调用
            if (isAppQuitting) {
              return;
            }
            
            console.log('[菜单退出] 用户通过菜单选择退出');
            isAppQuitting = true;
            
            if (ocrServerProcess) {
              console.log('[菜单退出] 正在关闭OCR服务...');
              try {
                if (!ocrServerStopPromise) {
                  ocrServerStopPromise = stopOcrServer();
                }
                await ocrServerStopPromise;
                console.log('[菜单退出] OCR服务已关闭');
              } catch (e) {
                console.error('[菜单退出] 关闭OCR服务时出错:', e);
              } finally {
                ocrServerProcess = null;
                ocrServerStopPromise = null;
              }
            }
            
            console.log('[菜单退出] 退出应用');
            app.exit(0);
          }
        }
      ]
    },
    {
      label: '视图',
      submenu: [
        { 
          label: '重新加载', 
          accelerator: 'CmdOrCtrl+R', 
          click: async () => {
             console.log('[菜单] 重新加载 - 检查OCR服务状态');
             try {
               // 先检查OCR服务是否正在运行
               const isHealthy = await checkOcrServerHealth();
               if (!isHealthy) {
                 console.log('[菜单] OCR服务未运行，启动服务...');
                 // 不强制重置状态，让startOcrServer自己处理并发
                 const started = await startOcrServer();
                 if (started) {
                   console.log('[菜单] OCR服务启动成功');
                 } else {
                   console.log('[菜单] OCR服务启动失败，但继续重新加载页面');
                 }
               } else {
                 console.log('[菜单] OCR服务正在运行，无需重启');
               }
               // 重新加载页面
               if (mainWindow) {
                 mainWindow.reload();
               }
             } catch (error) {
               console.error('[菜单] 重新加载失败:', error);
               // 即使OCR服务检查失败，也要重新加载页面
               if (mainWindow) {
                 mainWindow.reload();
               }
             }
           }
        },
        { 
          label: '强制重新加载', 
          accelerator: 'CmdOrCtrl+Shift+R', 
          click: async () => {
             console.log('[菜单] 强制重新加载 - 检查OCR服务状态');
             try {
               // 先检查OCR服务是否正在运行
               const isHealthy = await checkOcrServerHealth();
               if (!isHealthy) {
                 console.log('[菜单] OCR服务未运行，启动服务...');
                 // 不强制重置状态，让startOcrServer自己处理并发
                 const started = await startOcrServer();
                 if (started) {
                   console.log('[菜单] OCR服务启动成功');
                 } else {
                   console.log('[菜单] OCR服务启动失败，但继续强制重新加载页面');
                 }
               } else {
                 console.log('[菜单] OCR服务正在运行，无需重启');
               }
               // 强制重新加载页面
               if (mainWindow) {
                 mainWindow.webContents.reloadIgnoringCache();
               }
             } catch (error) {
               console.error('[菜单] 强制重新加载失败:', error);
               // 即使OCR服务检查失败，也要强制重新加载页面
               if (mainWindow) {
                 mainWindow.webContents.reloadIgnoringCache();
               }
             }
           }
        },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'PDF查看器',
              detail: '高质量PDF查看器\n版本: 1.0.0'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// 应用准备就绪
app.whenReady().then(async () => {
  // 加载OCR端口配置
  console.log('[应用启动] 正在加载OCR配置...');
  const configLoaded = loadOcrPortConfig();
  
  if (!configLoaded) {
    // 配置加载失败，显示错误对话框
    const { dialog } = require('electron');
    await dialog.showErrorBox(
      'OCR服务配置错误',
      '无法读取OCR服务端口配置。请检查app-config.json文件是否存在且包含正确的OCR端口信息。\n\n' +
      '配置文件应包含以下格式：\n' +
      '{\n' +
      '  "ocr_server_port": 8765,\n' +
      '}'
    );
    app.quit();
    return;
  }
  
  // 并行启动：同时创建窗口和启动OCR服务
  console.log('[应用启动] 并行启动前端窗口和OCR服务...');
  
  // 立即创建窗口
  createWindow();
  
  // 在后台异步启动OCR服务
  startOcrServerAsync();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 所有窗口关闭时退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 应用退出前的清理工作
app.on('before-quit', async (event) => {
  // 如果已经在退出流程中，直接返回
  if (isAppQuitting) {
    return;
  }
  
  // 标记正在退出
  isAppQuitting = true;
  
  // 无论是否有进程引用，都尝试关闭OCR服务
  event.preventDefault(); // 阻止立即退出
  console.log('[应用关闭] 正在关闭OCR服务...');
  
  try {
    if (!ocrServerStopPromise) {
      ocrServerStopPromise = stopOcrServer();
    }
    await ocrServerStopPromise;
    console.log('[应用关闭] OCR服务已关闭');
  } catch (e) {
    console.error('[应用关闭] 关闭OCR服务时出错:', e);
  } finally {
    ocrServerProcess = null;
    ocrServerStopPromise = null;
  }
  
  console.log('[应用关闭] 清理工作完成，应用即将退出');
  // 使用app.exit()直接退出，避免递归调用app.quit()
  app.exit(0);
});

// 处理应用意外退出
process.on('SIGINT', async () => {
  console.log('[应用关闭] 收到SIGINT信号，正在清理资源...');
  await stopOcrServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[应用关闭] 收到SIGTERM信号，正在清理资源...');
  await stopOcrServer();
  process.exit(0);
});

// 处理Windows控制台关闭事件
if (process.platform === 'win32') {
  process.on('SIGHUP', async () => {
    console.log('[应用关闭] 收到SIGHUP信号（控制台关闭），正在清理资源...');
    await stopOcrServer();
    process.exit(0);
  });
}

// 处理未捕获异常
process.on('uncaughtException', async (error) => {
  console.error('[应用异常] 未捕获异常:', error);
  try {
    await stopOcrServer();
  } catch (e) {
    console.error('[应用异常] 清理OCR服务时出错:', e);
  }
  process.exit(1);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', async (reason, promise) => {
  console.error('[应用异常] 未处理的Promise拒绝:', reason);
  try {
    await stopOcrServer();
  } catch (e) {
    console.error('[应用异常] 清理OCR服务时出错:', e);
  }
  process.exit(1);
});

// Windows特有：处理控制台关闭事件
if (process.platform === 'win32') {
  const readline = require('readline');
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.on('SIGINT', async () => {
      console.log('[应用关闭] 收到控制台中断信号，正在清理资源...');
      await stopOcrServer();
      process.exit(0);
    });
  }
}

// 启用高DPI支持
app.commandLine.appendSwitch('high-dpi-support', 'true');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// 禁用GPU加速，解决窗口显示问题
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// 获取当前PDF路径
ipcMain.handle('get-current-pdf-path', async (event) => {
  return currentPdfPath;
});

// 设置当前PDF路径并保存
ipcMain.handle('set-current-pdf-path', async (event, filePath) => {
  try {
    if (filePath && typeof filePath === 'string') {
      console.log('📝 保存PDF路径到配置:', filePath);
      currentPdfPath = filePath;
      saveAppSettings();
      return { success: true };
    } else {
      return { success: false, error: '无效的文件路径' };
    }
  } catch (error) {
    console.error('❌ 保存PDF路径失败:', error);
    return { success: false, error: error.message };
  }
});

// 检查文件权限
function checkFilePermissions(filePath) {
  try {
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      return { canWrite: false, reason: '文件不存在' };
    }
    
    // 获取文件状态
    const stats = fs.statSync(filePath);
    
    // 检查文件是否为只读
    if (!(stats.mode & parseInt('200', 8))) {
      return { canWrite: false, reason: '文件为只读模式' };
    }
    
    // 尝试以写入模式打开文件（不实际写入）
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    
    return { canWrite: true };
  } catch (error) {
    if (error.code === 'EACCES') {
      return { canWrite: false, reason: '没有写入权限' };
    } else if (error.code === 'EBUSY') {
      return { canWrite: false, reason: '文件被其他程序占用' };
    } else if (error.code === 'EROFS') {
      return { canWrite: false, reason: '文件位于只读文件系统' };
    } else {
      return { canWrite: false, reason: `权限检查失败: ${error.message}` };
    }
  }
}

// 保存文件到指定路径
ipcMain.handle('save-file', async (event, filePath, data) => {
  try {
    console.log('💾 收到保存文件请求:', filePath, '数据大小:', data?.length || 0);
    
    if (!filePath) {
      throw new Error('文件路径不能为空');
    }
    
    if (!data) {
      throw new Error('数据不能为空');
    }
    
    // 检查文件权限
    const permissionCheck = checkFilePermissions(filePath);
    if (!permissionCheck.canWrite) {
      console.warn('⚠️ 文件权限检查失败:', permissionCheck.reason);
      
      // 提供另存为选项
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '无法保存到原文件',
        message: `无法保存到原文件：${permissionCheck.reason}`,
        detail: '您可以选择另存为到其他位置。',
        buttons: ['另存为', '取消'],
        defaultId: 0,
        cancelId: 1
      });
      
      if (result.response === 0) {
        // 用户选择另存为
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '另存为PDF文件',
          defaultPath: path.basename(filePath),
          filters: [
            { name: 'PDF文件', extensions: ['pdf'] }
          ]
        });
        
        if (!saveResult.canceled && saveResult.filePath) {
          // 将数组转换为Buffer
          const buffer = Buffer.from(data);
          
          // 写入到新位置
          fs.writeFileSync(saveResult.filePath, buffer);
          
          console.log('✅ 文件另存为成功:', saveResult.filePath);
          return { 
            success: true, 
            message: `文件已另存为：${path.basename(saveResult.filePath)}`,
            savedPath: saveResult.filePath,
            wasSavedAs: true
          };
        } else {
          return { success: false, error: '用户取消了另存为操作' };
        }
      } else {
        return { success: false, error: `无法保存：${permissionCheck.reason}` };
      }
    }
    
    // 将数组转换为Buffer
    const buffer = Buffer.from(data);
    
    // 写入文件
    fs.writeFileSync(filePath, buffer);
    
    console.log('✅ 文件保存成功:', filePath);
    return { success: true, message: '文件保存成功' };
    
  } catch (error) {
    console.error('❌ 保存文件失败:', error);
    
    // 根据错误类型提供更详细的错误信息
    let errorMessage = error.message;
    if (error.code === 'EACCES') {
      errorMessage = '没有写入权限，请检查文件权限或以管理员身份运行';
    } else if (error.code === 'EBUSY') {
      errorMessage = '文件被其他程序占用，请关闭相关程序后重试';
    } else if (error.code === 'EROFS') {
      errorMessage = '文件位于只读文件系统，无法写入';
    } else if (error.code === 'ENOSPC') {
      errorMessage = '磁盘空间不足';
    }
    
    return { success: false, error: errorMessage };
  }
});

// OCR服务状态查询
ipcMain.handle('get-ocr-server-status', async () => {
  // 通过健康检查来判断服务是否真正运行，而不是依赖进程引用
  const isHealthy = await checkOcrServerHealth();
  const hasProcessRef = ocrServerProcess !== null;
  
  console.log(`[OCR服务] 状态查询结果: isHealthy=${isHealthy}, hasProcessRef=${hasProcessRef}, isOcrServerStarting=${isOcrServerStarting}`);
  
  return {
    isRunning: hasProcessRef || isOcrServerStarting, // 有进程引用或正在启动时为运行中
    isHealthy, // 健康检查结果
    hasProcessRef, // 额外提供进程引用状态供调试
    port: ocrServerPort,
    startupAttempts: ocrServerStartupAttempts,
    isStarting: isOcrServerStarting // 明确的启动状态
  };
});

// 手动触发OCR服务状态发送
ipcMain.handle('sync-ocr-server-status', async () => {
  try {
    console.log('[OCR服务] 收到手动同步状态请求');
    const isHealthy = await checkOcrServerHealth();
    const statusData = {
      status: isHealthy ? 'ready' : (isOcrServerStarting ? 'starting' : 'error'),
      message: isHealthy ? 'OCR服务已就绪' : 
               isOcrServerStarting ? '正在启动OCR服务...' : 'OCR服务未运行'
    };
    
    console.log('[OCR服务] 手动同步状态:', statusData);
    sendOCRStatusToFrontend(statusData.status, statusData.message);
    
    return { success: true, status: statusData };
  } catch (error) {
    console.error('[OCR服务] 手动同步状态失败:', error);
    return { success: false, error: error.message };
  }
});

// 手动重启OCR服务
ipcMain.handle('restart-ocr-server', async () => {
  try {
    console.log('[OCR服务] 收到手动重启请求');
    
    // 发送重启开始状态
    sendOCRStatusToFrontend('starting', '正在重启OCR服务...');
    
    // 无条件尝试关闭现有服务（stopOcrServer内部会通过健康检查判断是否需要关闭）
    await stopOcrServer();
    
    // 重置启动计数和状态
    ocrServerStartupAttempts = 0;
    isOcrServerStarting = false;
    
    // 重新启动服务（强制重启）
    const started = await startOcrServer(true);
    
    // 发送重启结果状态
    if (started) {
      sendOCRStatusToFrontend('ready', 'OCR服务重启成功');
    } else {
      sendOCRStatusToFrontend('error', 'OCR服务重启失败');
    }
    
    return { success: started, message: started ? 'OCR服务重启成功' : 'OCR服务重启失败' };
  } catch (error) {
    console.error('[OCR服务] 重启失败:', error.message);
    sendOCRStatusToFrontend('error', `重启失败: ${error.message}`);
    return { success: false, message: `重启失败: ${error.message}` };
  }
});

// ==================== UI 缩放控制 ====================

// 获取当前缩放比例
ipcMain.handle('get-zoom-factor', async () => {
  return currentZoomFactor;
});

// 设置缩放比例
ipcMain.handle('set-zoom-factor', async (event, factor) => {
  try {
    // 限制缩放范围在 0.5 到 1.5 之间
    const newFactor = Math.max(0.5, Math.min(1.5, factor));
    currentZoomFactor = newFactor;
    
    // 应用到当前窗口
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.setZoomFactor(newFactor);
    }
    
    // 保存设置
    saveAppSettings();
    
    console.log(`📐 UI缩放已设置为: ${newFactor}`);
    return { success: true, zoomFactor: newFactor };
  } catch (error) {
    console.error('❌ 设置缩放比例失败:', error);
    return { success: false, error: error.message };
  }
});

// 获取屏幕信息（用于调试或自动适配）
ipcMain.handle('get-screen-info', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
      width: primaryDisplay.workAreaSize.width,
      height: primaryDisplay.workAreaSize.height,
      scaleFactor: primaryDisplay.scaleFactor,
      currentZoom: currentZoomFactor
    };
  } catch (error) {
    return { error: error.message };
  }
});

// 重置为自动缩放
ipcMain.handle('reset-zoom-factor', async () => {
  try {
    currentZoomFactor = calculateAutoZoomFactor();
    
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.setZoomFactor(currentZoomFactor);
    }
    
    saveAppSettings();
    
    console.log(`📐 UI缩放已重置为自动: ${currentZoomFactor}`);
    return { success: true, zoomFactor: currentZoomFactor };
  } catch (error) {
    console.error('❌ 重置缩放比例失败:', error);
    return { success: false, error: error.message };
  }
});

// 发送OCR状态到前端的通用函数
function sendOCRStatusToFrontend(status, message) {
  const sendStatus = () => {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      console.log(`[OCR服务] 发送状态给前端: ${status} - ${message}`);
      mainWindow.webContents.send('ocr-server-status', { status, message });
    }
  };
  
  if (mainWindow && mainWindow.webContents) {
    // 如果窗口还在加载，等待加载完成
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', sendStatus);
    } else {
      // 延迟一点发送，确保前端已设置监听器
      setTimeout(sendStatus, 200);
    }
  }
}

// 异步启动OCR服务（用于并行启动）
async function startOcrServerAsync() {
  try {
    console.log('[OCR服务] 开始异步启动OCR服务...');
    
    // 通知前端OCR服务正在启动
    sendOCRStatusToFrontend('starting', '正在启动OCR服务...');
    
    const started = await startOcrServer();
    
    if (started) {
      console.log('[OCR服务] 异步启动成功');
      // 通知前端OCR服务启动成功
      sendOCRStatusToFrontend('ready', 'OCR服务已就绪');
    } else {
      console.error('[OCR服务] 异步启动失败');
      // 通知前端OCR服务启动失败
      sendOCRStatusToFrontend('error', 'OCR服务启动失败，OCR功能不可用');
    }
  } catch (error) {
    console.error('[OCR服务] 异步启动异常:', error);
    // 通知前端OCR服务启动异常
    sendOCRStatusToFrontend('error', `OCR服务启动异常: ${error.message}`);
  }
}

// 处理打开PDF对话框
ipcMain.on('open-pdf-dialog', () => {
  console.log('收到打开PDF对话框请求');
  if (!mainWindow) {
    console.error('主窗口不存在');
    return;
  }
  
  dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'PDF文件', extensions: ['pdf'] }
    ]
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      console.log('Electron: 选择的PDF文件:', filePath);
      
      // 读取文件内容并发送给渲染进程
      try {
        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);
        console.log('Electron: 读取文件成功，大小:', fileBuffer.length, '字节');
        
        // 保存当前PDF路径到全局变量
        currentPdfPath = filePath;
        
        // 保存应用设置（记住最后打开的文件）
        saveAppSettings();
        
        mainWindow.webContents.send('open-pdf', {
          fileName: fileName,
          buffer: fileBuffer,
          filePath: filePath  // 同时发送文件路径
        });
      } catch (error) {
        console.error('Electron: 读取文件失败:', error);
        mainWindow.webContents.send('open-pdf-error', error.message);
      }
    } else {
      console.log('Electron: 用户取消了文件选择');
    }
  });
});

// 处理 invoke 式打开PDF对话框（供 fileAdapter.openFile 使用）
// 与 open-pdf-dialog（send/on 模式）不同，这里使用 invoke/handle 可直接返回数据
ipcMain.handle('open-file-dialog', async () => {
  console.log('📂 收到 open-file-dialog 请求');
  if (!mainWindow) {
    return { canceled: true };
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF文件', extensions: ['pdf'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    console.log('✅ open-file-dialog: 读取文件成功:', filePath, '大小:', fileBuffer.length, '字节');

    // 同步更新主进程保存的当前路径
    currentPdfPath = filePath;
    saveAppSettings();

    return {
      canceled: false,
      filePath: filePath,
      fileName: fileName,
      buffer: fileBuffer
    };
  } catch (error) {
    console.error('❌ open-file-dialog: 读取文件失败:', error);
    throw error;
  }
});

// 处理氚云数据上传
console.log('✅ 注册 tritium-upload 处理程序...');
ipcMain.handle('tritium-upload', async (event, data) => {
  console.log('📥 收到氚云上传请求:', data);
  
  // ⚠️ 调试：检查BizObjectArray中的数据
  if (data.body && data.body.BizObjectArray && data.body.BizObjectArray.length > 0) {
    try {
      const firstObject = JSON.parse(data.body.BizObjectArray[0]);
      console.log('🔍 检查上传数据中的字段:');
      console.log('  - F0000037 (姓名):', firstObject.F0000037);
      console.log('  - F0000029 (人员类型):', firstObject.F0000029);
      console.log('  - F0000020 (时间):', firstObject.F0000020);
      console.log('  - 子表数据:', firstObject['D148357F67d10547274c48d7bc977b28a4a9c6a6']);
      
      // 检查姓名字段是否存在且有值
      if (!firstObject.F0000037) {
        console.error('❌ 警告：F0000037（姓名）字段为空！');
      } else {
        console.log('✅ F0000037（姓名）字段有值:', firstObject.F0000037);
      }
    } catch (e) {
      console.error('❌ 解析BizObjectArray失败:', e);
    }
  }
  
  try {
    // 尝试使用 node-fetch (如果是 ESM 环境) 或者回退到 http/https
    // 由于这是一个 CommonJS 环境，我们优先使用 https 模块
    const lib = data.url.startsWith('https') ? require('https') : require('http');
    const url = new URL(data.url);
    
    // 准备请求头
    const headers = {
      'Content-Type': 'application/json',
      'EngineCode': 'ety58sf4upb95mibri9qatvi5',
      'EngineSecret': 'u3toDgywMDwgbYgnrHNmjzH0g0fzn9mWAj0PY659taS7sxeVPoor5g==',
      'Accept': 'application/json',
      ...(data.headers || {})
    };
    
    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (data.url.startsWith('https') ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: headers
      };
      
      const req = lib.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          console.log('📨 氚云响应状态码:', res.statusCode);
          console.log('📨 氚云响应内容:', responseBody);
          
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(responseBody);
              // 检查氚云API的响应格式
              if (json.Successful === true) {
                console.log('✅ 氚云API返回成功');
                console.log('📋 返回数据:', JSON.stringify(json.ReturnData, null, 2));
                resolve({ success: true, data: json });
              } else {
                console.error('❌ 氚云API返回失败:', json.ErrorMessage || json.Message);
                resolve({ 
                  success: false, 
                  error: json.ErrorMessage || json.Message || '上传失败' 
                });
              }
            } catch (e) {
              console.error('❌ 解析氚云响应JSON失败:', e);
              resolve({ 
                success: false, 
                error: '服务器返回了无效的JSON格式: ' + e.message 
              });
            }
          } else {
            console.error('❌ HTTP错误，状态码:', res.statusCode);
            resolve({ 
              success: false, 
              error: `HTTP错误，状态码: ${res.statusCode}` 
            });
          }
        });
      });
      
      req.on('error', (e) => {
        console.error('请求错误:', e);
        resolve({ 
          success: false, 
          error: '网络请求失败: ' + e.message 
        });
      });
      
      const bodyString = JSON.stringify(data.body);
      console.log('发送请求体:', bodyString.substring(0, 500)); // 只打印前500个字符
      req.write(bodyString);
      req.end();
    });
    
  } catch (error) {
    console.error('氚云上传失败:', error);
    return { 
      success: false, 
      error: error.message || '未知错误' 
    };
  }
});

// 获取PDF书签/大纲
ipcMain.handle('get-pdf-bookmarks', async (event, pdfPath) => {
  console.log('📚 获取PDF书签:', pdfPath);
  
  try {
    if (!pdfPath) {
      throw new Error('PDF路径为空');
    }

    // 调用后端API获取书签
    const response = await axios.post(`http://127.0.0.1:${ocrServerPort}/api/pdf/bookmarks`, {
      pdf_path: pdfPath
    }, {
      timeout: 10000
    });

    if (response.data.success) {
      console.log('✅ 成功获取书签:', response.data.total || 0, '个');
      return {
        success: true,
        bookmarks: response.data.bookmarks || [],
        total: response.data.total || 0
      };
    } else {
      console.warn('⚠️ 获取书签失败:', response.data.message);
      return {
        success: false,
        error: response.data.message || '获取书签失败',
        bookmarks: []
      };
    }
  } catch (error) {
    console.error('❌ 获取PDF书签失败:', error.message);
    return {
      success: false,
      error: error.message || '获取书签失败',
      bookmarks: []
    };
  }
});

// 获取系统用户名
ipcMain.handle('get-user-name', async () => {
  try {
    const userName = require('os').userInfo().username;
    return userName;
  } catch (error) {
    console.error('获取用户名失败:', error);
    return '未知用户';
  }
});

// 获取桌面路径
ipcMain.handle('get-desktop-path', async () => {
  try {
    const desktopPath = app.getPath('desktop');
    return desktopPath;
  } catch (error) {
    console.error('获取桌面路径失败:', error);
    return app.getPath('home');
  }
});

// 处理PDF打印到文件（带文件选择对话框）
ipcMain.handle('print-to-pdf', async (event, options = {}) => {
  console.log('🖨️ 收到打印PDF请求');
  
  try {
    if (!mainWindow) {
      throw new Error('主窗口不存在');
    }

    // 设置默认打印选项 - 优化页面尺寸设置
    const printOptions = {
      pageSize: {
        width: 420000,  // A3宽度，单位为微米 (420mm) - 提供更大空间
        height: 297000  // A3高度，单位为微米 (297mm)
      },
      printBackground: true,
      landscape: false,  // 纵向，更适合PDF文档
      margins: {
        top: 5000,     // 5mm边距
        bottom: 5000,  // 5mm边距
        left: 5000,    // 5mm边距
        right: 5000    // 5mm边距
      },
      preferCSSPageSize: true,  // 使用CSS页面尺寸
      ...options
    };

    console.log('📄 开始生成PDF，选项:', printOptions);

    // 生成PDF数据
    const data = await mainWindow.webContents.printToPDF(printOptions);
    
    console.log('✅ PDF生成成功，大小:', data.length, '字节');

    // 显示保存对话框
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存PDF文件',
      defaultPath: `标注版-${new Date().toISOString().split('T')[0]}.pdf`,
      filters: [
        { name: 'PDF文件', extensions: ['pdf'] }
      ]
    });

    if (canceled) {
      console.log('🚫 用户取消了保存');
      return { success: false, message: '用户取消了保存' };
    }

    // 保存文件
    fs.writeFileSync(filePath, data);
    console.log('💾 PDF已保存到:', filePath);

    return { 
      success: true, 
      message: `PDF已保存到: ${path.basename(filePath)}`,
      filePath: filePath
    };

  } catch (error) {
    console.error('❌ 打印PDF失败:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

// 材料表OCR处理 - 使用Python后端服务
ipcMain.on('run-material-ocr', (event, { pdfPath, template }) => {
  console.log('🔍 收到材料表OCR请求:', { pdfPath, template });
  
  const scriptPath = path.join(__dirname, '../python/ocr_service.py');
  
  // 检查Python脚本是否存在
  if (!fs.existsSync(scriptPath)) {
    console.error('❌ OCR服务脚本不存在:', scriptPath);
    event.reply('ocr-result', { error: `OCR服务脚本不存在: ${scriptPath}` });
    return;
  }

  let tempImagePath = null;
  let actualPdfPath = pdfPath;

  // 如果模板包含图像数据，保存为临时文件
  if (template && template.image_data) {
    try {
      const tempDir = os.tmpdir();
      const timestamp = Date.now();
      tempImagePath = path.join(tempDir, `material_ocr_${timestamp}.png`);
      const imageBuffer = Buffer.from(template.image_data, 'base64');
      fs.writeFileSync(tempImagePath, imageBuffer);
      actualPdfPath = tempImagePath; // 使用临时图像文件路径
      console.log('💾 临时图像文件已保存:', tempImagePath);
      
      // 同时保存到项目的image文件夹
      try {
        const imageDir = path.join(__dirname, '../image');
        if (!fs.existsSync(imageDir)) {
          fs.mkdirSync(imageDir, { recursive: true });
        }
        const permanentImagePath = path.join(imageDir, `ocr_${timestamp}.png`);
        fs.writeFileSync(permanentImagePath, imageBuffer);
        console.log('💾 OCR图像已保存到image文件夹:', permanentImagePath);
      } catch (saveError) {
        console.warn('⚠️ 保存到image文件夹失败:', saveError);
        // 不中断OCR处理，只是警告
      }
    } catch (error) {
      console.error('❌ 保存临时图像文件失败:', error);
      event.reply('ocr-result', { error: `保存临时图像文件失败: ${error.message}` });
      return;
    }
  }

  // 将template参数写入临时文件，避免命令行参数过长
  let tempConfigPath = null;
  try {
    const tempDir = os.tmpdir();
    tempConfigPath = path.join(tempDir, `ocr_config_${Date.now()}.json`);
    fs.writeFileSync(tempConfigPath, JSON.stringify(template, null, 2));
    console.log('💾 临时配置文件已保存:', tempConfigPath);
  } catch (error) {
    console.error('❌ 保存临时配置文件失败:', error);
    event.reply('ocr-result', { error: `保存临时配置文件失败: ${error.message}` });
    return;
  }

  const pythonProcess = spawn('python', [scriptPath, actualPdfPath, tempConfigPath], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  // 确保以 UTF-8 解码标准输出/错误，避免中文乱码
  pythonProcess.stdout.setEncoding('utf8');
  pythonProcess.stderr.setEncoding('utf8');
  
  let stdout = '';
  pythonProcess.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  let stderr = '';
  pythonProcess.stderr.on('data', (data) => {
    const stderrData = data.toString();
    stderr += stderrData;
    
    // 解析进度信息
    const lines = stderrData.split('\n');
    lines.forEach(line => {
      if (line.startsWith('PROGRESS:')) {
        try {
          const progressJson = line.substring('PROGRESS:'.length);
          const progressData = JSON.parse(progressJson);
          // 发送进度更新到前端
          event.reply('ocr-progress', progressData);
        } catch (e) {
          // 忽略JSON解析错误
        }
      }
    });
  });

  let replied = false;
  function replyOnce(payload) {
    if (replied) return; 
    replied = true; 
    event.reply('ocr-result', payload);
  }

  pythonProcess.on('close', (code) => {
    // 清理临时文件
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      try {
        fs.unlinkSync(tempImagePath);
        console.log('🗑️ 临时图像文件已清理:', tempImagePath);
      } catch (error) {
        console.error('❌ 清理临时图像文件失败:', error);
      }
    }
    
    // 清理临时配置文件
    if (tempConfigPath && fs.existsSync(tempConfigPath)) {
      try {
        fs.unlinkSync(tempConfigPath);
        console.log('🗑️ 临时配置文件已清理:', tempConfigPath);
      } catch (error) {
        console.error('❌ 清理临时配置文件失败:', error);
      }
    }
    
    if (code !== 0) {
      console.error('❌ Python脚本执行失败，退出码:', code, '错误:', stderr);
      replyOnce({ error: `Python script exited with code ${code}: ${stderr}` });
    } else {
      try {
        const result = JSON.parse(stdout);
        console.log('✅ OCR处理完成，结果:', result);
        replyOnce(result);
      } catch (e) {
        console.error('❌ 解析Python输出失败:', e, '输出:', stdout);
        replyOnce({ error: `Failed to parse Python output: ${e}. Output was: ${stdout}` });
      }
    }
  });
});

// PaddleOCR相关处理器
let paddleOCRAvailable = false;

// 检查PaddleOCR是否可用
ipcMain.handle('check-paddle-ocr', async () => {
  return new Promise((resolve) => {
    exec('python -c "import paddleocr; print(\'available\')"', (error, stdout, stderr) => {
      if (error) {
        console.log('PaddleOCR不可用:', error.message);
        paddleOCRAvailable = false;
        resolve({ available: false, error: 'PaddleOCR未安装或Python环境不可用' });
      } else {
        console.log('PaddleOCR可用');
        paddleOCRAvailable = true;
        resolve({ available: true });
      }
    });
  });
});

// PaddleOCR处理
ipcMain.handle('paddle-ocr', async (event, base64Image) => {
  return new Promise((resolve, reject) => {
    // 创建临时文件存储图片
    const tempDir = os.tmpdir();
    const tempImagePath = path.join(tempDir, `ocr_temp_${Date.now()}.png`);
    const tempResultPath = path.join(tempDir, `ocr_result_${Date.now()}.json`);

    try {
      // 保存base64图片到临时文件
      const imageBuffer = Buffer.from(base64Image, 'base64');
      fs.writeFileSync(tempImagePath, imageBuffer);

      // 创建Python脚本来调用PaddleOCR
      const pythonScript = `
import sys
import json
import paddleocr
import cv2
import numpy as np

# 读取图片路径和结果路径
image_path = sys.argv[1]
result_path = sys.argv[2]

try:
    # 初始化PaddleOCR
    ocr = paddleocr.PaddleOCR(
        use_textline_orientation=True, 
        lang='ch'
    )
    
    # 执行OCR
    result = ocr.ocr(image_path)
    
    # 处理结果
    processed_result = []
    if result and result[0]:
        for line in result[0]:
            if line and len(line) >= 2:
                box = line[0]  # 坐标
                text_info = line[1]  # 文字和置信度
                
                # 安全地提取文本和置信度
                if isinstance(text_info, (list, tuple)) and len(text_info) >= 2:
                    text = text_info[0] if text_info[0] else ""
                    confidence = text_info[1] if len(text_info) > 1 else 0.0
                elif isinstance(text_info, str):
                    text = text_info
                    confidence = 1.0
                else:
                    text = str(text_info) if text_info else ""
                    confidence = 0.0
                
                processed_result.append({
                    'box': box,
                    'text': text,
                    'confidence': confidence
                })
    
    # 保存结果到JSON文件
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(processed_result, f, ensure_ascii=False, indent=2)
    
    print("OCR处理完成")
    
except Exception as e:
    error_result = {"error": str(e)}
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(error_result, f, ensure_ascii=False, indent=2)
    print(f"OCR处理失败: {e}")
`;

      // 创建临时Python文件
      const tempPythonPath = path.join(tempDir, `ocr_script_${Date.now()}.py`);
      fs.writeFileSync(tempPythonPath, pythonScript);

      // 执行Python脚本
      const pythonProcess = spawn('python', [tempPythonPath, tempImagePath, tempResultPath], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        try {
          // 清理临时文件
          if (fs.existsSync(tempImagePath)) fs.unlinkSync(tempImagePath);
          if (fs.existsSync(tempPythonPath)) fs.unlinkSync(tempPythonPath);

          if (code !== 0) {
            console.error('PaddleOCR Python脚本执行失败:', stderr);
            resolve({ error: `Python script failed: ${stderr}` });
            return;
          }

          // 读取结果文件
          if (fs.existsSync(tempResultPath)) {
            const resultData = fs.readFileSync(tempResultPath, 'utf8');
            const result = JSON.parse(resultData);
            
            // 清理结果文件
            fs.unlinkSync(tempResultPath);
            
            resolve(result);
          } else {
            resolve({ error: '未找到OCR结果文件' });
          }
        } catch (error) {
          console.error('处理OCR结果时出错:', error);
          resolve({ error: error.message });
        }
      });

    } catch (error) {
      console.error('PaddleOCR处理出错:', error);
      resolve({ error: error.message });
    }
  });
});

// 快速保存PDF到桌面
ipcMain.handle('quick-save-pdf', async (event, options = {}) => {
  console.log('🚀 收到快速保存PDF请求');
  
  try {
    if (!mainWindow) {
      throw new Error('主窗口不存在');
    }

    // 设置默认打印选项
    const printOptions = {
      pageSize: {
        width: 420000,  // A3宽度
        height: 297000  // A3高度
      },
      printBackground: true,
      landscape: false,
      margins: {
        top: 5000,
        bottom: 5000,
        left: 5000,
        right: 5000
      },
      preferCSSPageSize: true,
      ...options
    };

    // 生成PDF数据
    const data = await mainWindow.webContents.printToPDF(printOptions);
    
    // 获取桌面路径
    const desktopPath = path.join(os.homedir(), 'Desktop');
    const fileName = `标注版-${new Date().toISOString().split('T')[0]}-${Date.now()}.pdf`;
    const filePath = path.join(desktopPath, fileName);

    // 保存文件
    fs.writeFileSync(filePath, data);
    console.log('💾 PDF已快速保存到桌面:', filePath);

    return { 
      success: true, 
      message: `PDF已保存到桌面: ${fileName}`,
      filePath: filePath
    };

  } catch (error) {
    console.error('❌ 快速保存PDF失败:', error);
    return { 
      success: false, 
      error: error.message 
    };
  }
});

console.log('🎉 electron.js 文件加载完成，所有 IPC handlers 已注册');
