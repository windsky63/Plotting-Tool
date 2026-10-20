import { useState, useCallback, useRef } from 'react';

// Callbacks held by annotation commands must only reach the CURRENT stack.
// Capturing a rendered stack lets command -> old callback -> old stack chains
// keep evicted commands (and their annotation indexes) alive indefinitely.
const useHistoryStack = () => {
  const [stack, publishStack] = useState([]);
  const stackRef = useRef(stack);
  const setStack = useCallback(update => {
    const next = typeof update === 'function' ? update(stackRef.current) : update;
    stackRef.current = next;
    publishStack(next);
  }, []);
  return [stack, stackRef, setStack];
};

/**
 * 撤销重做Hook - 基于命令模式的简单实现
 * 
 * @param {Object} options - 配置选项
 * @param {number} options.maxHistorySize - 最大历史记录数量，默认50
 * @returns {Object} 撤销重做相关方法和状态
 */
export const useUndoRedo = (options = {}) => {
  const { maxHistorySize = 50 } = options;
  const debugLog = (...args) => {
    if (process.env.NODE_ENV === 'development') console.log(...args);
  };
  
  // 撤销栈和重做栈
  const [undoStack, undoStackRef, setUndoStack] = useHistoryStack();
  const [redoStack, redoStackRef, setRedoStack] = useHistoryStack();
  
  // 批量操作标记
  const batchRef = useRef(null);
  
  /**
   * 执行命令并添加到撤销栈
   * @param {Object} command - 命令对象
   * @param {Function} command.execute - 执行函数
   * @param {Function} command.undo - 撤销函数  
   * @param {string} command.description - 命令描述（可选）
   */
  const executeCommand = useCallback((command) => {
    if (!command || typeof command.execute !== 'function' || typeof command.undo !== 'function') {
      console.error('Invalid command: must have execute and undo functions');
      return;
    }
    
    try {
      // 执行命令
      debugLog(`🚀 执行命令: ${command.description || '未知操作'}`);
      command.execute();
      
      // 如果在批量操作中，添加到批量操作组
      if (batchRef.current) {
        batchRef.current.commands.push(command);
        debugLog(`📦 命令已添加到批量操作 "${batchRef.current.description}" (当前包含 ${batchRef.current.commands.length} 个命令)`);
        return;
      }
      
      // 添加到撤销栈
      setUndoStack(prev => {
        const newStack = [...prev, command];
        // 限制栈大小
        if (newStack.length > maxHistorySize) {
          newStack.shift(); // 移除最老的记录
        }
        debugLog(`📚 命令已添加到撤销栈 (总数: ${newStack.length})`);
        return newStack;
      });
      
      // 清空重做栈
      setRedoStack([]);
      debugLog('✅ 命令执行成功');
      
    } catch (error) {
      console.error('❌ 命令执行失败:', error);
    }
  }, [maxHistorySize, setUndoStack, setRedoStack]);
  
  /**
   * 撤销上一个操作
   */
  const undo = useCallback(() => {
    const undoStack = undoStackRef.current;
    if (undoStack.length === 0) {
      debugLog('🔄 撤销操作: 撤销栈为空，无法撤销');
      return;
    }
    
    const command = undoStack[undoStack.length - 1];
    debugLog(`🔄 执行撤销: ${command.description || '未知操作'} (剩余 ${undoStack.length - 1} 个可撤销操作)`);
    
    try {
      // 执行撤销
      command.undo();
      
      // 移动命令从撤销栈到重做栈
      setUndoStack(prev => prev.slice(0, -1));
      setRedoStack(prev => [...prev, command]);
      
      debugLog('✅ 撤销成功');
    } catch (error) {
      console.error('❌ 撤销失败:', error);
    }
  }, [setUndoStack, setRedoStack]);
  
  /**
   * 重做下一个操作
   */
  const redo = useCallback(() => {
    const redoStack = redoStackRef.current;
    if (redoStack.length === 0) {
      debugLog('🔄 重做操作: 重做栈为空，无法重做');
      return;
    }
    
    const command = redoStack[redoStack.length - 1];
    debugLog(`🔄 执行重做: ${command.description || '未知操作'} (剩余 ${redoStack.length - 1} 个可重做操作)`);
    
    try {
      // 重新执行命令
      command.execute();
      
      // 移动命令从重做栈到撤销栈
      setRedoStack(prev => prev.slice(0, -1));
      setUndoStack(prev => {
        const newStack = [...prev, command];
        // 限制栈大小
        if (newStack.length > maxHistorySize) {
          newStack.shift();
        }
        return newStack;
      });
      
      debugLog('✅ 重做成功');
    } catch (error) {
      console.error('❌ 重做失败:', error);
    }
  }, [maxHistorySize, setUndoStack, setRedoStack]);
  
  /**
   * 开始批量操作
   * @param {string} description - 批量操作描述
   */
  const startBatch = useCallback((description = 'Batch operation') => {
    if (batchRef.current) {
      console.warn('⚠️ 批量操作已经开始，忽略新的批量操作请求');
      return;
    }
    
    debugLog(`📦 开始批量操作: ${description}`);
    batchRef.current = {
      description,
      commands: []
    };
  }, []);
  
  /**
   * 结束批量操作
   */
  const endBatch = useCallback(() => {
    if (!batchRef.current) {
      console.warn('⚠️ 没有进行中的批量操作需要结束');
      return;
    }
    
    const batch = batchRef.current;
    debugLog(`🏁 结束批量操作: ${batch.description} (包含 ${batch.commands.length} 个命令)`);
    batchRef.current = null;
    
    // 如果批量操作中有命令，创建批量命令
    if (batch.commands.length > 0) {
      const batchCommand = {
        description: batch.description,
        execute: () => {
          // 批量执行已经完成，这里不需要重新执行
        },
        undo: () => {
          // 反向撤销所有命令
          debugLog(`🔄 执行批量撤销: ${batch.description} (${batch.commands.length} 个命令)`);
          for (let i = batch.commands.length - 1; i >= 0; i--) {
            batch.commands[i].undo();
          }
        }
      };
      
      // 添加批量命令到撤销栈
      setUndoStack(prev => {
        const newStack = [...prev, batchCommand];
        if (newStack.length > maxHistorySize) {
          newStack.shift();
        }
        debugLog(`📚 批量命令已添加到撤销栈 (总数: ${newStack.length})`);
        return newStack;
      });
      
      // 清空重做栈
      setRedoStack([]);
    } else {
      debugLog('📝 批量操作为空，跳过添加到撤销栈');
    }
  }, [maxHistorySize, setUndoStack, setRedoStack]);
  
  /**
   * 清空所有历史记录
   */
  const clearHistory = useCallback(() => {
    setUndoStack([]);
    setRedoStack([]);
    batchRef.current = null;
  }, [setUndoStack, setRedoStack]);

  // Once a local draft checkpoint exists, old command closures no longer need
  // to retain many generations of large annotation arrays in browser memory.
  const trimHistory = useCallback((keepLatest = 10) => {
    const limit = Math.max(0, Number(keepLatest) || 0);
    setUndoStack(prev => limit ? prev.slice(-limit) : []);
    setRedoStack([]);
  }, [setUndoStack, setRedoStack]);
  
  /**
   * 获取历史记录信息
   */
  const getHistoryInfo = useCallback(() => {
    const undoStack = undoStackRef.current;
    const redoStack = redoStackRef.current;
    return {
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
      lastUndoDescription: undoStack.length > 0 ? undoStack[undoStack.length - 1].description : null,
      lastRedoDescription: redoStack.length > 0 ? redoStack[redoStack.length - 1].description : null,
      isBatching: batchRef.current !== null
    };
  }, []);
  
  return {
    // 主要操作方法
    executeCommand,
    undo,
    redo,
    
    // 批量操作方法
    startBatch,
    endBatch,
    
    // 工具方法
    clearHistory,
    trimHistory,
    getHistoryInfo,
    
    // 状态
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoCount: undoStack.length,
    redoCount: redoStack.length
  };
};

/**
 * 创建简单的状态变更命令
 * @param {Function} setter - 状态设置函数
 * @param {*} newValue - 新值
 * @param {*} oldValue - 旧值
 * @param {string} description - 命令描述
 * @returns {Object} 命令对象
 */
export const createStateChangeCommand = (setter, newValue, oldValue, description) => {
  return {
    description,
    execute: () => setter(newValue),
    undo: () => setter(oldValue)
  };
};

/**
 * 创建数组操作命令
 */
export const createArrayCommands = {
  /**
   * 添加元素命令
   */
  add: (setter, element, description = 'Add element') => ({
    description,
    execute: () => setter(prev => [...prev, element]),
    undo: () => setter(prev => prev.slice(0, -1))
  }),
  
  /**
   * 删除元素命令
   */
  remove: (setter, index, description = 'Remove element') => {
    let removedElement;
    return {
      description,
      execute: () => setter(prev => {
        removedElement = prev[index];
        return prev.filter((_, i) => i !== index);
      }),
      undo: () => setter(prev => {
        const newArray = [...prev];
        newArray.splice(index, 0, removedElement);
        return newArray;
      })
    };
  },
  
  /**
   * 更新元素命令
   */
  update: (setter, index, newElement, description = 'Update element') => {
    let oldElement;
    return {
      description,
      execute: () => setter(prev => {
        oldElement = prev[index];
        const newArray = [...prev];
        newArray[index] = newElement;
        return newArray;
      }),
      undo: () => setter(prev => {
        const newArray = [...prev];
        newArray[index] = oldElement;
        return newArray;
      })
    };
  }
};

export default useUndoRedo;
