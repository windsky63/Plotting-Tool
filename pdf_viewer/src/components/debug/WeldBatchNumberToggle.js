import React from 'react';
import { Button, Tooltip, Slider } from 'antd';
import { NumberOutlined, ThunderboltOutlined } from '@ant-design/icons';

export const WeldBatchNumberToggle = ({ 
  disabled = false,
  weldCount = 0,
  embedded = false,
  animationSpeed = 100,
  onAnimationSpeedChange,
  showNumbers = false,
  onToggleNumbers
}) => {
  const getTooltipContent = () => {
    if (disabled) {
      return (
        <div>
          <div>⚠️ 请先启用焊点识别</div>
          <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
            点击"焊点识别"按钮后才能使用批量编号功能
          </div>
        </div>
      );
    }
    
    return (
      <div>
        <div>{showNumbers ? '退出单页多段编号' : '进入单页多段编号'}</div>
        <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
          当前识别到 {weldCount} 个焊点
        </div>
        <div style={{ marginTop: 4, fontSize: '12px', opacity: 0.9 }}>
          依次点击起点→终点，可连续添加多段，最后统一生成
        </div>
        {onAnimationSpeedChange && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: '12px', marginBottom: 4 }}>
              <ThunderboltOutlined /> 动画速度: {animationSpeed}ms
            </div>
            <Slider
              min={20}
              max={500}
              step={20}
              value={animationSpeed}
              onChange={onAnimationSpeedChange}
              style={{ width: 150 }}
              tooltip={{ formatter: (value) => `${value}ms` }}
            />
          </div>
        )}
      </div>
    );
  };
  
  const fixedStyle = {
    position: 'fixed',
    top: '330px',
    left: '270px',
    zIndex: 1000,
  };
  
  const embeddedStyle = {
    width: '100%',
  };
  
  return (
    <Tooltip title={getTooltipContent()} placement="left">
      <Button
        type="text"
        icon={<NumberOutlined />}
        onClick={onToggleNumbers}
        disabled={disabled}
        style={{
          ...(embedded ? embeddedStyle : fixedStyle),
          background: showNumbers ? 'rgba(24, 144, 255, 0.1)' : 'rgba(255, 255, 255, 0.9)',
          border: showNumbers ? '1px solid #1890ff' : '1px solid #d9d9d9',
          borderRadius: '6px',
          fontSize: '12px',
          opacity: disabled ? 0.5 : 1,
          color: showNumbers ? '#1890ff' : undefined
        }}
      >
        {showNumbers ? '多段编号中' : '多段起止编号'}
      </Button>
    </Tooltip>
  );
};
