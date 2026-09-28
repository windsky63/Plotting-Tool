/**
 * OCR上下文 - 全局OCR状态管理
 */

import React, { createContext, useContext } from 'react';
import { useOCRState } from '../hooks/useOCRState';

const OCRContext = createContext(null);

/**
 * OCR上下文提供者
 */
export const OCRProvider = ({ children }) => {
  const ocrState = useOCRState();
  
  return (
    <OCRContext.Provider value={ocrState}>
      {children}
    </OCRContext.Provider>
  );
};

/**
 * 使用OCR上下文的Hook
 */
export const useOCRContext = () => {
  const context = useContext(OCRContext);
  
  if (!context) {
    throw new Error('useOCRContext must be used within an OCRProvider');
  }
  
  return context;
};

export default OCRContext;
