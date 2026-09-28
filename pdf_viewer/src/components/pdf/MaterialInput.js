/**
 * PDF材料编号输入功能模块
 * 负责处理材料编号输入对话框的所有状态管理和逻辑
 */

import { useState, useCallback } from 'react';

export const useMaterialInput = ({
  // 回调函数
  onAnnotationAdd,
  onAnnotationUpdate
}) => {
  
  // 材料编号输入对话框状态
  const [materialInputVisible, setMaterialInputVisible] = useState(false);
  const [materialNumber1, setMaterialNumber1] = useState('');
  const [materialNumber2, setMaterialNumber2] = useState('');
  const [pendingAnnotation, setPendingAnnotation] = useState(null);
  const [materialInputTimer, setMaterialInputTimer] = useState(null);
  const [isAutoFocusing, setIsAutoFocusing] = useState(false); // 标记是否正在自动跳转焦点

  // 关闭材料编号输入对话框
  const closeMaterialInput = useCallback(() => {
    // 关闭前先保存材料编号 - 直接从DOM获取最新值，避免闭包问题
    const currentPendingAnnotation = pendingAnnotation; // 缓存当前值
    
    if (currentPendingAnnotation) {
      // 从DOM直接获取当前值，确保是最新的
      const input1 = document.getElementById('material-input-1');
      const input2 = document.getElementById('material-input-2');
      const currentValue1 = input1?.value || '';
      const currentValue2 = input2?.value || '';
      // 格式化为 X-X 格式
      const materialNumber = currentValue1 && currentValue2 ? `${currentValue1}-${currentValue2}` : 
                            currentValue1 || currentValue2;
      
      // 如果有任何输入，就保存
      if (materialNumber && onAnnotationUpdate) {
        const updatedAnnotation = {
          materialNumber: materialNumber
        };
        onAnnotationUpdate(currentPendingAnnotation.id, updatedAnnotation);
      }
    }
    
    setMaterialInputVisible(false);
    setMaterialNumber1('');
    setMaterialNumber2('');
    setPendingAnnotation(null);
    setIsAutoFocusing(false); // 清除自动跳转标记
    
    // 清除定时器
    if (materialInputTimer) {
      clearTimeout(materialInputTimer);
      setMaterialInputTimer(null);
    }
  }, [pendingAnnotation, materialInputTimer, onAnnotationUpdate]);

  // 更新当前标注的材料编号
  const savePendingAnnotation = useCallback(() => {
    const currentPendingAnnotation = pendingAnnotation; // 缓存当前值
    
    if (currentPendingAnnotation) {
      // 从DOM直接获取最新值，避免依赖状态
      const input1 = document.getElementById('material-input-1');
      const input2 = document.getElementById('material-input-2');
      const currentValue1 = input1?.value || '';
      const currentValue2 = input2?.value || '';
      
      // 格式化为 X-X 格式
      const materialNumber = currentValue1 && currentValue2 ? `${currentValue1}-${currentValue2}` : 
                            currentValue1 || currentValue2;
      
      // 更新已保存的标注（无论是否有材料编号都更新）
      const updatedAnnotation = {
        materialNumber: materialNumber || undefined
      };

      // 更新标注
      if (onAnnotationUpdate) {
        onAnnotationUpdate(currentPendingAnnotation.id, updatedAnnotation);
      }
    }
  }, [pendingAnnotation, onAnnotationUpdate]);

  // 显示材料编号输入对话框
  const showMaterialInput = useCallback((annotation) => {
    // 如果已有对话框打开，先保存并关闭
    if (materialInputVisible && pendingAnnotation) {
      savePendingAnnotation();
      closeMaterialInput();
    }

    // 先保存标注，再显示材料编号输入框
    const finalAnnotation = {
      ...annotation,
      // 如果标注没有ID，生成一个新的ID
      id: annotation.id || `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: annotation.timestamp || new Date().toISOString()
    };

    // 立即保存标注到列表
    if (onAnnotationAdd) {
      onAnnotationAdd(finalAnnotation);
    }

    // 设置为待编辑状态，用于后续更新材料编号
    setPendingAnnotation(finalAnnotation);
    setMaterialNumber1('');
    setMaterialNumber2('');
    setIsAutoFocusing(false);
    setMaterialInputVisible(true);

    // 设置2秒自动关闭定时器
    const timer = setTimeout(() => {
      closeMaterialInput();
    }, 2000);
    setMaterialInputTimer(timer);
  }, [materialInputVisible, pendingAnnotation, savePendingAnnotation, closeMaterialInput, onAnnotationAdd]);

  // 处理第一个材料编号输入框的变化
  const handleMaterialNumber1Change = useCallback((e) => {
    const value = e.target.value;
    if (/^\d{0,2}$/.test(value)) {
      setMaterialNumber1(value);
      // 输入完2位数字后自动跳到下一个输入框
      if (value.length === 2) {
        // 清除可能存在的自动关闭定时器，避免因焦点切换而意外关闭
        if (materialInputTimer) {
          clearTimeout(materialInputTimer);
          setMaterialInputTimer(null);
        }
        // 标记正在进行自动跳转
        setIsAutoFocusing(true);
        document.getElementById('material-input-2')?.focus();
        // 短暂延迟后清除标记
        setTimeout(() => setIsAutoFocusing(false), 100);
      }
    }
  }, [materialInputTimer]);

  // 处理第二个材料编号输入框的变化
  const handleMaterialNumber2Change = useCallback((e) => {
    const value = e.target.value;
    if (/^\d{0,2}$/.test(value)) {
      setMaterialNumber2(value);
      // 如果第二个输入框也输入了2位数字，自动保存并关闭
      if (value.length === 2 && materialNumber1.length === 2) {
        // 清除可能存在的定时器
        if (materialInputTimer) {
          clearTimeout(materialInputTimer);
          setMaterialInputTimer(null);
        }
        // 短暂延迟后自动保存并关闭
        setTimeout(() => {
          closeMaterialInput();
        }, 500); // 给用户一点时间看到输入结果
      }
    }
  }, [materialInputTimer, materialNumber1, closeMaterialInput]);

  // 处理输入框获得焦点
  const handleInputFocus = useCallback(() => {
    // 输入框获得焦点时暂停自动关闭
    if (materialInputTimer) {
      clearTimeout(materialInputTimer);
      setMaterialInputTimer(null);
    }
  }, [materialInputTimer]);

  // 处理第二个输入框的特殊焦点逻辑
  const handleInput2Focus = useCallback(() => {
    // 清除自动关闭定时器
    if (materialInputTimer) {
      clearTimeout(materialInputTimer);
      setMaterialInputTimer(null);
    }
    // 如果是由于自动跳转获得焦点，清除自动跳转标记
    if (isAutoFocusing) {
      setIsAutoFocusing(false);
    }
  }, [materialInputTimer, isAutoFocusing]);

  // 处理输入框失去焦点（目前为空实现，完全禁用失去焦点时的自动关闭）
  const handleInputBlur = useCallback(() => {
    // 完全禁用失去焦点时的自动关闭功能
    // 用户只能通过确认按钮或2秒超时来关闭输入框
  }, []);

  return {
    // 状态
    materialInputVisible,
    materialNumber1,
    materialNumber2,
    pendingAnnotation,
    materialInputTimer,
    isAutoFocusing,
    
    // 状态设置器
    setMaterialInputVisible,
    setMaterialNumber1,
    setMaterialNumber2,
    setPendingAnnotation,
    setMaterialInputTimer,
    setIsAutoFocusing,
    
    // 方法
    closeMaterialInput,
    savePendingAnnotation,
    showMaterialInput,
    
    // 事件处理器
    handleMaterialNumber1Change,
    handleMaterialNumber2Change,
    handleInputFocus,
    handleInput2Focus,
    handleInputBlur
  };
};

export default useMaterialInput;
