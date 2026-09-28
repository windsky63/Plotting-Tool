/**
 * 配置管理适配器
 * 根据运行环境自动选择 Electron 配置文件 或 localStorage
 */

import { isElectron, hasElectronAPI } from '../utils/platformDetect';
import { DEFAULT_OCR_SERVER_HOST, DEFAULT_OCR_SERVER_PORT } from '../config/ocrServer';

class ConfigAdapter {
  constructor() {
    this.storageKey = 'pdf-viewer-config';
    this.defaultConfig = {
      ocr_server_port: DEFAULT_OCR_SERVER_PORT,
      ocr_server_host: DEFAULT_OCR_SERVER_HOST,
      ocr_backend: 'exe',
      ocr_backend_exe_path: 'ocr_server/ocr_server.exe',
      confidence_threshold: 0.4
    };
  }

  /**
   * 获取配置
   * @returns {Promise<Object>} 配置对象
   */
  async getConfig() {
    if (isElectron() && hasElectronAPI('getConfig')) {
      // Electron 环境：从配置文件读取
      try {
        const result = await window.electronAPI.getConfig();
        
        if (result.error) {
          console.warn('读取 Electron 配置失败，使用默认配置:', result.error);
          return this.defaultConfig;
        }
        
        // 合并默认配置和读取的配置
        return { ...this.defaultConfig, ...result };
      } catch (error) {
        console.error('获取 Electron 配置时出错:', error);
        return this.defaultConfig;
      }
    } else {
      // Web 环境：从 localStorage 读取
      try {
        let fileConfig = {};
        try {
          const response = await fetch(`${process.env.PUBLIC_URL || ''}/app-config.json`, {
            cache: 'no-store'
          });
          if (response.ok) {
            fileConfig = await response.json();
          }
        } catch (configError) {
          console.warn('Failed to load app-config.json, falling back to local config', configError);
        }

        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          const config = JSON.parse(stored);
          return { ...this.defaultConfig, ...config, ...fileConfig };
        }
        return { ...this.defaultConfig, ...fileConfig };
      } catch (error) {
        console.error('读取 localStorage 配置失败:', error);
        return this.defaultConfig;
      }
    }
  }

  /**
   * 保存配置
   * @param {Object} config - 配置对象
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async saveConfig(config) {
    if (isElectron() && hasElectronAPI('saveConfig')) {
      // Electron 环境：保存到配置文件
      try {
        const result = await window.electronAPI.saveConfig(config);
        
        if (result.error) {
          console.error('保存 Electron 配置失败:', result.error);
          return { success: false, error: result.error };
        }
        
        return { success: true };
      } catch (error) {
        console.error('保存 Electron 配置时出错:', error);
        return { success: false, error: error.message };
      }
    } else {
      // Web 环境：保存到 localStorage
      try {
        // 合并现有配置
        const currentConfig = await this.getConfig();
        const mergedConfig = { ...currentConfig, ...config };
        
        localStorage.setItem(this.storageKey, JSON.stringify(mergedConfig));
        console.log('✅ 配置已保存到 localStorage:', mergedConfig);
        
        return { success: true };
      } catch (error) {
        console.error('保存 localStorage 配置失败:', error);
        return { success: false, error: error.message };
      }
    }
  }

  /**
   * 获取特定配置项
   * @param {string} key - 配置键名
   * @param {*} defaultValue - 默认值
   * @returns {Promise<*>}
   */
  async getConfigValue(key, defaultValue = null) {
    try {
      const config = await this.getConfig();
      return config[key] !== undefined ? config[key] : defaultValue;
    } catch (error) {
      console.error(`获取配置项 ${key} 失败:`, error);
      return defaultValue;
    }
  }

  /**
   * 设置特定配置项
   * @param {string} key - 配置键名
   * @param {*} value - 配置值
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setConfigValue(key, value) {
    try {
      const config = await this.getConfig();
      config[key] = value;
      return await this.saveConfig(config);
    } catch (error) {
      console.error(`设置配置项 ${key} 失败:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * 重置配置为默认值
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async resetConfig() {
    console.log('重置配置为默认值:', this.defaultConfig);
    return await this.saveConfig(this.defaultConfig);
  }

  /**
   * 清除所有配置
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async clearConfig() {
    if (isElectron() && hasElectronAPI('saveConfig')) {
      // Electron 环境：保存空配置
      return await this.saveConfig({});
    } else {
      // Web 环境：清除 localStorage
      try {
        localStorage.removeItem(this.storageKey);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    }
  }

  /**
   * 导出配置（用于备份）
   * @returns {Promise<string>} JSON 字符串
   */
  async exportConfig() {
    const config = await this.getConfig();
    return JSON.stringify(config, null, 2);
  }

  /**
   * 导入配置（用于恢复）
   * @param {string} configJson - JSON 字符串
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async importConfig(configJson) {
    try {
      const config = JSON.parse(configJson);
      return await this.saveConfig(config);
    } catch (error) {
      console.error('导入配置失败:', error);
      return { success: false, error: '配置格式错误' };
    }
  }

  /**
   * 获取 OCR 服务端口（最常用的配置）
   * @returns {Promise<number>}
   */
  async getOCRPort() {
    return await this.getConfigValue('ocr_server_port', 8766);
  }

  /**
   * 设置 OCR 服务端口
   * @param {number} port - 端口号
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setOCRPort(port) {
    return await this.setConfigValue('ocr_server_port', port);
  }
}

// 导出单例实例
export const configAdapter = new ConfigAdapter();
export default configAdapter;
