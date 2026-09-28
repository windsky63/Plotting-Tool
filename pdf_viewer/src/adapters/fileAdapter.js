/**
 * 文件操作适配器
 * 根据运行环境自动选择 Electron API 或 Web API
 */

import { isElectron, hasElectronAPI } from '../utils/platformDetect';
import { message } from 'antd';

class FileAdapter {
  constructor() {
    // 保存通过 showOpenFilePicker 获取的文件句柄，供保存时直接写回原文件
    this.fileHandle = null;
  }

  /**
   * 打开 PDF 文件
   * Electron: 使用原生文件对话框
   * Web（现代浏览器）: 使用 showOpenFilePicker 获取可写文件句柄
   * Web（降级）: 使用 <input type="file">
   * @returns {Promise<{file: File|string, fileName: string, filePath: string, arrayBuffer: ArrayBuffer}>}
   */
  async openPDF() {
    if (isElectron() && hasElectronAPI('openFile')) {
      // Electron 环境：使用原生文件对话框
      try {
        const result = await window.electronAPI.openFile();
        if (result.canceled || !result.filePath) {
          throw new Error('用户取消选择文件');
        }
        
        return {
          file: result.filePath,
          fileName: result.fileName || '未命名.pdf',
          filePath: result.filePath,
          arrayBuffer: result.buffer
        };
      } catch (error) {
        console.error('Electron 打开文件失败:', error);
        throw error;
      }
    } else {
      // Web 环境：优先使用 showOpenFilePicker（可获取写权限句柄，支持直接覆盖原文件）
      if (typeof window.showOpenFilePicker === 'function') {
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{ description: 'PDF文件', accept: { 'application/pdf': ['.pdf'] } }],
            multiple: false
          });
          this.fileHandle = handle; // 保存句柄，保存时直接写回
          const file = await handle.getFile();
          const arrayBuffer = await file.arrayBuffer();
          return {
            file: file,
            fileName: file.name,
            filePath: `web:${file.name}`,
            arrayBuffer: arrayBuffer
          };
        } catch (err) {
          if (err.name === 'AbortError') {
            throw new Error('用户取消选择文件');
          }
          // showOpenFilePicker 出错，降级为 <input type="file">
          console.warn('showOpenFilePicker 失败，降级为 input:', err);
          this.fileHandle = null;
        }
      }

      // 降级方案：传统 <input type="file">（无写权限，保存时走下载）
      this.fileHandle = null;
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        
        input.onchange = async (e) => {
          const file = e.target.files[0];
          if (!file) {
            reject(new Error('未选择文件'));
            return;
          }
          
          try {
            const arrayBuffer = await file.arrayBuffer();
            resolve({
              file: file,
              fileName: file.name,
              filePath: `blob:${file.name}`,
              arrayBuffer: arrayBuffer
            });
          } catch (error) {
            reject(error);
          }
        };
        
        input.oncancel = () => {
          reject(new Error('用户取消选择文件'));
        };
        
        input.click();
      });
    }
  }

  /**
   * 保存 PDF 文件
   * @param {Uint8Array|ArrayBuffer} pdfData - PDF 数据
   * @param {string} defaultFileName - 默认文件名
   * @returns {Promise<{success: boolean, savedPath?: string, message?: string}>}
   */
  async savePDF(pdfData, defaultFileName = '标注版.pdf') {
    if (isElectron() && hasElectronAPI('saveFile')) {
      // Electron 环境：使用原生保存对话框
      try {
        // 直接传递 Uint8Array，避免转换为数组导致内存溢出
        const uint8Array = pdfData instanceof ArrayBuffer 
          ? new Uint8Array(pdfData)
          : pdfData;
        
        const result = await window.electronAPI.saveFile(
          defaultFileName,
          uint8Array
        );
        
        return result;
      } catch (error) {
        console.error('Electron 保存文件失败:', error);
        throw error;
      }
    } else {
      // Web 环境
      try {
        const blob = new Blob([pdfData], { type: 'application/pdf' });

        // 优先：通过已存储的 fileHandle 直接写回原文件（无需弹窗）
        if (this.fileHandle) {
          try {
            const writable = await this.fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            return {
              success: true,
              savedPath: this.fileHandle.name,
              message: '已成功保存到原文件'
            };
          } catch (handleError) {
            console.warn('通过文件句柄写回原文件失败，降级为另存为:', handleError);
            this.fileHandle = null; // 句柄失效，清除后走降级路径
          }
        }

        // 降级：showSaveFilePicker 弹出另存为对话框
        // 注意：Windows Chrome 存在已知问题——用户在"是否替换"确认框点击"是"后，
        // picker 仍可能以 AbortError 结束（OS 替换确认被误判为取消）。
        // 因此对 picker 的任何失败均降级为下载，不向用户报错。
        if ('showSaveFilePicker' in window) {
          let pickedHandle = null;
          try {
            pickedHandle = await window.showSaveFilePicker({
              suggestedName: defaultFileName,
              types: [{
                description: 'PDF文件',
                accept: { 'application/pdf': ['.pdf'] }
              }]
            });
          } catch (pickerError) {
            // 无论是用户取消（AbortError）还是其他错误，均降级为下载
            console.warn('showSaveFilePicker 未能完成，降级为下载:', pickerError.name, pickerError.message);
          }

          if (pickedHandle) {
            try {
              // 存储句柄，下次 Ctrl+S 可直接写回，无需再弹对话框
              this.fileHandle = pickedHandle;
              const writable = await pickedHandle.createWritable();
              await writable.write(blob);
              await writable.close();
              return {
                success: true,
                savedPath: pickedHandle.name,
                message: `文件已保存: ${pickedHandle.name}`
              };
            } catch (writeError) {
              // 写入失败，清除句柄并降级为下载
              console.warn('文件写入失败，降级为下载:', writeError);
              this.fileHandle = null;
            }
          }
        }
        
        // 最终降级：传统下载方式
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultFileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        setTimeout(() => URL.revokeObjectURL(url), 100);
        
        return {
          success: true,
          savedPath: defaultFileName,
          message: `文件已下载: ${defaultFileName}`
        };
      } catch (error) {
        console.error('Web 保存文件失败:', error);
        return {
          success: false,
          error: error.message
        };
      }
    }
  }

  /**
   * 打印 PDF 到文件（Electron 专用功能）
   * @param {Object} options - 打印选项
   * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
   */
  async printToPDF(options = {}) {
    if (isElectron() && hasElectronAPI('printToPDF')) {
      try {
        return await window.electronAPI.printToPDF(options);
      } catch (error) {
        console.error('打印 PDF 失败:', error);
        return {
          success: false,
          error: error.message
        };
      }
    } else {
      // Web 环境：提示用户使用浏览器打印功能
      message.info('请使用浏览器的打印功能 (Ctrl+P)');
      window.print();
      return {
        success: true,
        message: '已调用浏览器打印功能'
      };
    }
  }

  /**
   * 读取文件内容
   * @param {File} file - 文件对象
   * @returns {Promise<ArrayBuffer>}
   */
  async readFileAsArrayBuffer(file) {
    if (file instanceof File) {
      // Web File API
      return await file.arrayBuffer();
    } else if (typeof file === 'string') {
      // Electron 文件路径
      if (isElectron() && window.electronAPI && window.electronAPI.readFile) {
        return await window.electronAPI.readFile(file);
      } else {
        throw new Error('无法读取文件：不支持的文件类型或环境');
      }
    } else if (file instanceof ArrayBuffer) {
      return file;
    } else {
      throw new Error('不支持的文件类型');
    }
  }

  /**
   * 获取文件的 Blob URL（用于 PDF.js）
   * @param {File|ArrayBuffer} file - 文件对象或数据
   * @returns {string} Blob URL 或文件路径
   */
  getFileURL(file) {
    if (file instanceof File) {
      return URL.createObjectURL(file);
    } else if (file instanceof ArrayBuffer) {
      const blob = new Blob([file], { type: 'application/pdf' });
      return URL.createObjectURL(blob);
    } else if (typeof file === 'string') {
      // Electron 文件路径
      return file;
    } else {
      throw new Error('不支持的文件类型');
    }
  }

  /**
   * 拖放文件处理
   * @param {DragEvent} event - 拖放事件
   * @returns {Promise<{file: File, fileName: string, arrayBuffer: ArrayBuffer}>}
   */
  async handleFileDrop(event) {
    event.preventDefault();
    event.stopPropagation();

    const files = event.dataTransfer.files;
    if (files.length === 0) {
      throw new Error('未检测到文件');
    }

    const file = files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      throw new Error('请选择 PDF 文件');
    }

    const arrayBuffer = await file.arrayBuffer();

    // 拖放方式无法获取写权限句柄，清除以确保保存时走下载路径
    this.fileHandle = null;

    return {
      file: file,
      fileName: file.name,
      filePath: `blob:${file.name}`,
      arrayBuffer: arrayBuffer
    };
  }
}

// 导出单例实例
export const fileAdapter = new FileAdapter();
export default fileAdapter;
