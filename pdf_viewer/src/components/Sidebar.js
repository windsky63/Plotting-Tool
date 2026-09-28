import React, { useState, useEffect } from 'react';
import { Layout, Tabs, List, Avatar, Tag, Button, Empty, Tooltip } from 'antd';
import { 
  FileTextOutlined, 
  HighlightOutlined, 
  SearchOutlined,
  DeleteOutlined,
  EditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BookOutlined
} from '@ant-design/icons';
import styled from 'styled-components';
import BookmarkPanel from './BookmarkPanel';

const { Sider } = Layout;

const SidebarContainer = styled(Sider)`
  background: #fafafa !important;
  border-right: 1px solid #e8e8e8;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
`;

const CollapseButton = styled(Button)`
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 10;
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: white;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  
  &:hover {
    background: #f0f0f0;
  }
`;

const TabsContainer = styled(Tabs)`
  flex: 1;
  display: flex;
  flex-direction: column;
  
  .ant-tabs-content-holder {
    flex: 1;
    overflow: hidden;
  }
  
  .ant-tabs-tabpane {
    height: 100%;
    overflow: auto;
    padding: 8px;
  }
`;

const ThumbnailContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
`;

const ThumbnailItem = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px;
  border: 2px solid ${props => props.$isActive ? '#1890ff' : 'transparent'};
  border-radius: 8px;
  cursor: pointer;
  background: ${props => props.$isActive ? '#e6f7ff' : 'white'};
  transition: all 0.2s;
  
  &:hover {
    border-color: #1890ff;
    background: #f0f8ff;
  }
`;

const ThumbnailPage = styled.div`
  width: 120px;
  height: auto;
  border-radius: 4px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  background: white;
`;

const PageNumber = styled.div`
  margin-top: 8px;
  font-size: 12px;
  color: #666;
  text-align: center;
`;

const AnnotationItem = styled.div`
  padding: 12px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  background: white;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    border-color: #1890ff;
    box-shadow: 0 2px 8px rgba(24, 144, 255, 0.1);
  }
`;

const AnnotationHeader = styled.div`
  display: flex;
  justify-content: between;
  align-items: center;
  margin-bottom: 8px;
`;

const AnnotationContent = styled.div`
  font-size: 12px;
  color: #666;
  line-height: 1.4;
  margin-bottom: 8px;
`;

const AnnotationMeta = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #999;
`;

const SearchResultItem = styled.div`
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 4px;
  cursor: pointer;
  background: ${props => props.$isActive ? '#e6f7ff' : 'white'};
  border: 1px solid ${props => props.$isActive ? '#1890ff' : '#e8e8e8'};
  transition: all 0.2s;
  
  &:hover {
    border-color: #1890ff;
    background: #f0f8ff;
  }
`;

const Sidebar = ({ 
  visible, 
  pdfFile, 
  pdfFilePath,  // 新增：PDF文件路径，用于获取书签
  currentPage, 
  totalPages, 
  onPageChange,
  searchResults = [],
  currentSearchIndex = -1,
  onSearchResultClick,
  annotations = [],
  onAnnotationClick,
  onAnnotationDelete,
  onAnnotationEdit,
  onToggle
}) => {
  const [activeTab, setActiveTab] = useState('annotations');
  const [collapsed, setCollapsed] = useState(false);

  // 获取标注图标
  const getAnnotationIcon = (type) => {
    switch (type) {
      case 'highlight':
        return <HighlightOutlined style={{ color: '#faad14' }} />;
      case 'underline':
        return <EditOutlined style={{ color: '#1890ff' }} />;
      case 'strikethrough':
        return <EditOutlined style={{ color: '#ff4d4f' }} />;
      case 'rectangle':
        return <EditOutlined style={{ color: '#52c41a' }} />;
      case 'text':
        return <EditOutlined style={{ color: '#722ed1' }} />;
      case 'circle':
        return <EditOutlined style={{ color: '#13c2c2' }} />;
      default:
        return <EditOutlined />;
    }
  };

  // 获取标注类型标签颜色
  const getAnnotationTagColor = (type) => {
    switch (type) {
      case 'highlight':
        return 'gold';
      case 'underline':
        return 'blue';
      case 'strikethrough':
        return 'red';
      case 'rectangle':
        return 'green';
      case 'text':
        return 'purple';
      case 'circle':
        return 'cyan';
      default:
        return 'default';
    }
  };

  // 格式化时间
  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // 处理标注点击
  const handleAnnotationClick = (annotation) => {
    onPageChange(annotation.page);
    onAnnotationClick?.(annotation);
  };

  // 处理折叠切换
  const handleToggleCollapse = () => {
    setCollapsed(!collapsed);
    if (onToggle) {
      onToggle();
    }
  };

  // 标注标签页内容
  const annotationsTab = (
    <div>
      {annotations.length > 0 ? (
        annotations.map(annotation => (
          <AnnotationItem
            key={annotation.id}
            onClick={() => handleAnnotationClick(annotation)}
          >
            <AnnotationHeader>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {getAnnotationIcon(annotation.type)}
                <Tag color={getAnnotationTagColor(annotation.type)}>
                  {annotation.type}
                </Tag>
                <span style={{ fontSize: '12px', color: '#666' }}>
                  第 {annotation.page} 页
                </span>
              </div>
              <div>
                <Tooltip title="编辑">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAnnotationEdit?.(annotation);
                    }}
                  />
                </Tooltip>
                <Tooltip title="删除">
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAnnotationDelete?.(annotation.id);
                    }}
                  />
                </Tooltip>
              </div>
            </AnnotationHeader>
            
            {(annotation.content || annotation.text) && (
              <AnnotationContent>
                {annotation.text || annotation.content}
                {annotation.ruleName && (
                  <Tag size="small" color="cyan" style={{ marginLeft: '8px' }}>
                    {annotation.ruleName}
                  </Tag>
                )}
              </AnnotationContent>
            )}
            
            <AnnotationMeta>
              <span>
                <div
                  style={{
                    display: 'inline-block',
                    width: '12px',
                    height: '12px',
                    backgroundColor: annotation.color,
                    borderRadius: '2px',
                    marginRight: '4px'
                  }}
                />
                {annotation.color}
              </span>
              <span>{formatTime(annotation.timestamp)}</span>
            </AnnotationMeta>
          </AnnotationItem>
        ))
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无标注"
        />
      )}
    </div>
  );

  // 搜索结果标签页内容
  const searchTab = (
    <div>
      {searchResults.length > 0 ? (
        searchResults.map((result, index) => (
          <SearchResultItem
            key={`search_${index}`}
            $isActive={index === currentSearchIndex}
            onClick={() => onSearchResultClick(result.page)}
          >
            <div style={{ 
              fontSize: '12px', 
              color: '#666',
              marginBottom: '4px'
            }}>
              第 {result.page} 页
            </div>
            <div style={{ 
              fontSize: '13px',
              lineHeight: '1.4'
            }}>
              {result.text}
            </div>
          </SearchResultItem>
        ))
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无搜索结果"
        />
      )}
    </div>
  );

  // 书签标签页内容
  const bookmarksTab = (
    <div style={{ height: '100%', padding: 0 }}>
      <BookmarkPanel 
        pdfFilePath={pdfFilePath}
        currentPage={currentPage}
        onPageChange={onPageChange}
      />
    </div>
  );

  const tabItems = [
    {
      key: 'bookmarks',
      label: (
        <span>
          <BookOutlined />
          书签
        </span>
      ),
      children: bookmarksTab,
    },
    {
      key: 'annotations',
      label: (
        <span>
          <HighlightOutlined />
          标注 ({annotations.length})
        </span>
      ),
      children: annotationsTab,
    },
    {
      key: 'search',
      label: (
        <span>
          <SearchOutlined />
          搜索 ({searchResults.length})
        </span>
      ),
      children: searchTab,
    },
  ];

  if (!visible) {
    return null;
  }

  return (
    <SidebarContainer 
      width={collapsed ? 0 : 280} 
      theme="light"
      collapsed={collapsed}
      collapsedWidth={0}
    >
      <CollapseButton
        type="text"
        icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        onClick={handleToggleCollapse}
        title={collapsed ? "展开标注管理栏" : "收起标注管理栏"}
      />
      
      {!collapsed && (
        <TabsContainer
          activeKey={activeTab}
          onChange={setActiveTab}
          items={tabItems}
          size="small"
        />
      )}
    </SidebarContainer>
  );
};

export default Sidebar;
