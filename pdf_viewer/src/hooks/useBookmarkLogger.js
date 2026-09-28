/**
 * 书签日志记录Hook
 * 提供便捷的书签日志记录功能
 */

import { useState, useCallback, useRef } from 'react';
import { bookmarkLogger } from '../utils/bookmarkLogger';
import { message } from 'antd';
import { buildOcrServerUrl } from '../config/ocrServer';

export const useBookmarkLogger = () => {
  const [isLogging, setIsLogging] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const bookmarksRef = useRef([]);
  
  // 使用 ref 存储实时状态，避免闭包问题
  const sessionStateRef = useRef({
    isLogging: false,
    sessionId: null
  });

  /**
   * 获取PDF书签
   */
  const fetchBookmarks = useCallback(async (pdfFilePath, pdfFile) => {
    try {
      console.log('📚 fetchBookmarks 开始:', { pdfFilePath, hasPdfFile: !!pdfFile });
      
      let result;

      // Electron环境
      if (window.electronAPI && window.electronAPI.getPDFBookmarks && pdfFilePath) {
        console.log('📚 使用 Electron IPC 获取书签');
        result = await window.electronAPI.getPDFBookmarks(pdfFilePath);
      } 
      // Web环境
      else {
        console.log('🌐 Web环境，获取配置...');
        const configResponse = await fetch('./app-config.json');
        if (!configResponse.ok) {
          throw new Error('无法读取配置文件');
        }

        const config = await configResponse.json();
        const port = config.ocr_server_port;
        console.log('🌐 OCR端口:', port);

        if (!port) {
          throw new Error('配置文件中缺少OCR服务端口信息');
        }

        // 获取OCR服务器地址（支持局域网访问）
        const serverHost = config.ocr_server_host || window.location.hostname || '127.0.0.1';
        const ocrServerUrl = buildOcrServerUrl(serverHost, port);
        console.log('🌐 OCR服务器地址:', ocrServerUrl);

        // 文件路径方式
        if (pdfFilePath && typeof pdfFilePath === 'string' && !pdfFilePath.startsWith('blob:')) {
          console.log('🌐 使用文件路径方式获取书签');
          const response = await fetch(`${ocrServerUrl}/api/pdf/bookmarks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pdf_path: pdfFilePath })
          });
          result = await response.json();
        }
        // 文件上传方式
        else if (pdfFile && pdfFile instanceof File) {
          console.log('🌐 使用文件上传方式获取书签, 文件名:', pdfFile.name);
          const formData = new FormData();
          formData.append('pdf_file', pdfFile);
          const response = await fetch(`${ocrServerUrl}/api/pdf/bookmarks-upload`, {
            method: 'POST',
            body: formData
          });
          
          if (!response.ok) {
            console.error('❌ 书签上传请求失败:', response.status, response.statusText);
            return [];
          }
          
          result = await response.json();
        } else {
          console.warn('⚠️ 无法获取PDF文件或路径');
          return [];
        }
      }

      console.log('📚 书签API返回结果:', result);

      if (result?.success && result.bookmarks) {
        bookmarksRef.current = result.bookmarks;
        console.log('✅ 成功获取书签:', result.bookmarks.length, '个');
        return result.bookmarks;
      }

      console.log('ℹ️ PDF没有书签');
      return [];
    } catch (error) {
      console.error('❌ 获取书签失败:', error);
      return [];
    }
  }, []);

  /**
   * 开始记录会话
   */
  const startLogging = useCallback(async (pdfName, operationType, pdfFilePath, pdfFile) => {
    try {
      console.log('📝 startLogging 被调用:', { pdfName, operationType, pdfFilePath, hasPdfFile: !!pdfFile });
      
      // 立即更新 ref 状态
      sessionStateRef.current.isLogging = true;
      setIsLogging(true);

      // 焊点编号日志只需按页码记录。不再为了日志分组上传整份 PDF 读取书签。
      const skipBookmarks = operationType === 'weld_numbering';
      let bookmarks = [];
      if (skipBookmarks) {
        console.log('📚 焊点编号日志按页码记录，跳过书签读取');
      } else {
        console.log('📚 正在获取书签...');
        bookmarks = await fetchBookmarks(pdfFilePath, pdfFile);
        console.log('📚 书签获取完成，数量:', bookmarks.length);
      }
      
      // 开始会话
      const sessionId = await bookmarkLogger.startSession(pdfName, operationType, bookmarks);
      
      // 立即更新 ref 状态
      sessionStateRef.current.sessionId = sessionId;
      setCurrentSessionId(sessionId);

      console.log(`✅ 开始记录${operationType === 'material_ocr' ? '材料表识别' : '焊点批量编号'}会话, sessionId:`, sessionId);
      
      return sessionId;
    } catch (error) {
      console.error('❌ 开始记录失败:', error);
      sessionStateRef.current.isLogging = false;
      sessionStateRef.current.sessionId = null;
      setIsLogging(false);
      return null;
    }
  }, [fetchBookmarks]);

  /**
   * 记录页面处理
   */
  const logPage = useCallback((pageNum, pageData, status = 'success') => {
    // 使用 ref 获取最新状态
    if (!sessionStateRef.current.isLogging || !sessionStateRef.current.sessionId) {
      console.warn('⚠️ logPage 被调用但没有活跃会话');
      return;
    }

    console.log(`📄 记录第${pageNum}页:`, pageData);
    bookmarkLogger.logPage(pageNum, pageData, status);
  }, []);

  /**
   * 结束记录会话
   */
  const endLogging = useCallback(async () => {
    // 使用 ref 获取最新状态
    const { isLogging: refIsLogging, sessionId: refSessionId } = sessionStateRef.current;
    
    console.log('📝 endLogging 被调用, isLogging:', refIsLogging, 'sessionId:', refSessionId);
    
    if (!refIsLogging || !refSessionId) {
      console.warn('⚠️ 没有活跃的日志会话，跳过保存');
      return null;
    }

    try {
      console.log('💾 开始保存日志...');
      const result = await bookmarkLogger.endSession();
      
      // 清空 ref 状态
      sessionStateRef.current.isLogging = false;
      sessionStateRef.current.sessionId = null;
      
      setIsLogging(false);
      setCurrentSessionId(null);
      bookmarksRef.current = [];

      if (result) {
        console.log('✅ 处理日志已保存/下载');
        message.success('处理日志已保存', 3);
      } else {
        console.warn('⚠️ endSession 返回 null');
      }

      return result;
    } catch (error) {
      console.error('❌ 结束记录失败:', error);
      sessionStateRef.current.isLogging = false;
      sessionStateRef.current.sessionId = null;
      setIsLogging(false);
      setCurrentSessionId(null);
      return null;
    }
  }, []);

  /**
   * 取消记录
   */
  const cancelLogging = useCallback(() => {
    sessionStateRef.current.isLogging = false;
    sessionStateRef.current.sessionId = null;
    setIsLogging(false);
    setCurrentSessionId(null);
    bookmarksRef.current = [];
    console.log('❌ 取消记录会话');
  }, []);

  return {
    isLogging,
    currentSessionId,
    startLogging,
    logPage,
    endLogging,
    cancelLogging
  };
};

export default useBookmarkLogger;
