/**
 * 平台检测工具
 * 检测当前运行环境是 Electron 还是 Web 浏览器
 */

/**
 * 检测是否在 Electron 环境中运行
 * @returns {boolean} 如果在 Electron 中返回 true，否则返回 false
 */
export function isElectron() {
  // 检查多个指标以确保准确性
  const hasElectronAPI = typeof window !== 'undefined' && window.electronAPI && typeof window.electronAPI === 'object';
  const hasRequire = typeof window !== 'undefined' && window.require;
  const userAgent = typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron');
  
  return hasElectronAPI || hasRequire || userAgent;
}

/**
 * 检测是否在 Web 浏览器中运行
 * @returns {boolean} 如果在浏览器中返回 true
 */
export function isWeb() {
  return !isElectron();
}

/**
 * 获取平台类型字符串
 * @returns {string} 'electron' 或 'web'
 */
export function getPlatform() {
  return isElectron() ? 'electron' : 'web';
}

/**
 * 检测特定的 Electron API 是否可用
 * @param {string} apiName - API 名称
 * @returns {boolean} API 是否可用
 */
export function hasElectronAPI(apiName) {
  return isElectron() && 
         window.electronAPI && 
         typeof window.electronAPI[apiName] === 'function';
}

/**
 * 打印当前平台信息（用于调试）
 */
export function logPlatformInfo() {
  console.log('📱 平台检测信息:');
  console.log('  - 运行环境:', getPlatform());
  console.log('  - Electron API:', !!window.electronAPI);
  console.log('  - User Agent:', navigator.userAgent);
  
  if (isElectron()) {
    console.log('  - 可用的 Electron APIs:');
    if (window.electronAPI) {
      Object.keys(window.electronAPI).forEach(key => {
        console.log(`    ✓ ${key}`);
      });
    }
  }
}

export default {
  isElectron,
  isWeb,
  getPlatform,
  hasElectronAPI,
  logPlatformInfo
};

