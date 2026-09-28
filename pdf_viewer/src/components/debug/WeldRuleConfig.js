// 焊点规则配置面板
import React, { useState, useEffect, useMemo } from 'react';
import styled from 'styled-components';
import { WeldRuleManager } from '../../utils/WeldRuleManager';

const ConfigPanel = styled.div`
  ${props => props.$embedded ? `
    position: relative;
    width: 100%;
    margin-top: 8px;
  ` : `
  position: fixed;
  top: 460px;
    left: 270px;
    max-width: 340px;
  `}
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 12px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  z-index: 1002;
  font-size: 13px;
`;

const Header = styled.div`
  font-weight: bold;
  margin-bottom: 8px;
  color: #333;
  border-bottom: 1px solid #eee;
  padding-bottom: 5px;
`;

const RuleItem = styled.div`
  display: flex;
  align-items: center;
  margin: 5px 0;
  padding: 4px 0;
  
  &:hover {
    background: #f5f5f5;
  }
`;

const Checkbox = styled.input`
  margin-right: 8px;
  cursor: pointer;
`;

const Label = styled.label`
  cursor: pointer;
  color: #555;
  flex: 1;
`;

const ButtonGroup = styled.div`
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #eee;
`;

const Button = styled.button`
  flex: 1;
  padding: 5px;
  border: 1px solid #ddd;
  border-radius: 3px;
  background: white;
  cursor: pointer;
  font-size: 11px;
  
  &:hover {
    background: #f0f0f0;
  }
  
  &:active {
    background: #e0e0e0;
  }
`;

const ToggleButton = styled.button`
  ${props => props.$embedded ? `
    width: 100%;
    position: relative;
  ` : `
  position: fixed;
  top: 410px;
    left: 270px;
  `}
  padding: 8px 14px;
  background: rgba(255, 255, 255, 0.95);
  color: #333;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  z-index: 1001;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  transition: all 0.2s;
  
  &:hover:not(:disabled) {
    background: rgba(255, 255, 255, 1);
    border-color: #40a9ff;
    color: #40a9ff;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  
  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
`;

export const WeldRuleConfig = ({ ruleManager: externalRuleManager, onRulesChange, weldDebugEnabled = false, currentPage, enableOCRFilter, onOCRFilterChange, embedded = false }) => {
  const [showPanel, setShowPanel] = useState(false);
  const [rules, setRules] = useState([]);

  // 创建独立的规则管理器实例（如果外部没有提供）
  const internalRuleManager = useMemo(() => {
    const manager = new WeldRuleManager();
    manager.loadConfig();
    return manager;
  }, []);

  // 使用外部提供的或内部创建的规则管理器
  const ruleManager = externalRuleManager || internalRuleManager;

  // 加载规则
  useEffect(() => {
    if (ruleManager) {
      const allRules = ruleManager.getAllRules();
      setRules(allRules);
      console.log('✅ 焊点规则管理器已加载，共', allRules.length, '个规则');
    }
  }, [ruleManager]);

  const handleToggleRule = (ruleId) => {
    if (!ruleManager) return;
    
    const rule = rules.find(r => r.id === ruleId);
    if (rule) {
      const newEnabled = !rule.enabled;
      ruleManager.setRuleEnabled(ruleId, newEnabled);
      
      // 保存到 localStorage
      ruleManager.saveConfig();
      
      // 更新本地状态
      setRules(rules.map(r => 
        r.id === ruleId ? { ...r, enabled: newEnabled } : r
      ));
      
      // 通知父组件重新识别
      if (onRulesChange) {
        onRulesChange();
      }
    }
  };

  const handleEnableAll = () => {
    if (!ruleManager) return;
    
    rules.forEach(rule => {
      ruleManager.setRuleEnabled(rule.id, true);
    });
    
    // 保存到 localStorage
    ruleManager.saveConfig();
    
    setRules(rules.map(r => ({ ...r, enabled: true })));
    
    if (onRulesChange) {
      onRulesChange();
    }
  };

  const handleDisableAll = () => {
    if (!ruleManager) return;
    
    rules.forEach(rule => {
      ruleManager.setRuleEnabled(rule.id, false);
    });
    
    // 保存到 localStorage
    ruleManager.saveConfig();
    
    setRules(rules.map(r => ({ ...r, enabled: false })));
    
    if (onRulesChange) {
      onRulesChange();
    }
  };

  const enabledCount = rules.filter(r => r.enabled).length;
  const isReady = ruleManager && rules.length > 0;

  // 组件始终渲染，按钮始终可见
  return (
    <>
      <ToggleButton 
        $embedded={embedded}
        onClick={() => setShowPanel(!showPanel)}
        disabled={!isReady}
        style={{ 
          opacity: isReady ? 1 : 0.6,
          cursor: isReady ? 'pointer' : 'wait',
          background: weldDebugEnabled ? 'rgba(255, 165, 0, 0.1)' : 'rgba(255, 255, 255, 0.95)',
          borderColor: weldDebugEnabled ? '#FFA500' : '#d9d9d9',
          color: weldDebugEnabled ? '#FF8C00' : '#333'
        }}
        title={weldDebugEnabled ? '焊点识别已启用，配置规则将立即生效' : '配置规则，启用焊点识别后生效'}
      >
        ⚙️ 规则 {isReady ? `(${enabledCount}/${rules.length})` : '...'}
      </ToggleButton>
      
      {showPanel && (
        <ConfigPanel $embedded={embedded}>
          <Header>
            🔍 焊点识别规则
            {weldDebugEnabled && (
              <span style={{ 
                fontSize: '11px', 
                color: '#52c41a', 
                marginLeft: '8px',
                fontWeight: 'normal'
              }}>
                ● 已启用
              </span>
            )}
            {!weldDebugEnabled && (
              <span style={{ 
                fontSize: '11px', 
                color: '#999', 
                marginLeft: '8px',
                fontWeight: 'normal'
              }}>
                ○ 未启用
              </span>
            )}
          </Header>
          
          {rules.map(rule => (
            <RuleItem key={rule.id}>
              <Checkbox
                type="checkbox"
                id={rule.id}
                checked={rule.enabled}
                onChange={() => handleToggleRule(rule.id)}
              />
              <Label htmlFor={rule.id} title={rule.description}>
                {rule.name}
              </Label>
            </RuleItem>
          ))}
          
          {/* OCR文字过滤选项 */}
          <div style={{ 
            marginTop: '10px', 
            paddingTop: '10px', 
            borderTop: '1px solid #eee' 
          }}>
            <RuleItem>
              <Checkbox
                type="checkbox"
                id="ocr-filter"
                checked={enableOCRFilter !== undefined ? enableOCRFilter : true}
                onChange={(e) => onOCRFilterChange && onOCRFilterChange(e.target.checked)}
              />
              <Label htmlFor="ocr-filter" title="使用OCR识别的文字区域来过滤焊点，避免将文字误识别为焊点">
                🔤 OCR文字过滤
              </Label>
            </RuleItem>
            <div style={{ 
              fontSize: '11px', 
              color: '#666', 
              marginLeft: '24px',
              marginTop: '3px',
              lineHeight: '1.4'
            }}>
              自动过滤OCR识别的文字区域，减少误识别
            </div>
          </div>
          
          <ButtonGroup>
            <Button onClick={handleEnableAll}>全部启用</Button>
            <Button onClick={handleDisableAll}>全部禁用</Button>
          </ButtonGroup>
        </ConfigPanel>
      )}
    </>
  );
};

