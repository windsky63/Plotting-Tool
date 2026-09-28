import React, { useState, useEffect } from 'react';
import { Tree, Spin, Empty, Card, message, Button, Space, Tooltip } from 'antd';
import { BookOutlined, FileTextOutlined, ExpandOutlined, ShrinkOutlined } from '@ant-design/icons';
import styled from 'styled-components';
import { isElectron } from '../utils/platformDetect';
import { buildOcrServerUrl } from '../config/ocrServer';

const BookmarkContainer = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
`;

const BookmarkHeader = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 500;
  font-size: 14px;
  color: #262626;
  background: #fafafa;
  border-radius: 4px 4px 0 0;
`;

const BookmarkTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const BookmarkContent = styled.div`
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px;
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  
  &::-webkit-scrollbar-track {
    background: #f0f0f0;
    border-radius: 3px;
  }
  
  &::-webkit-scrollbar-thumb {
    background: #bfbfbf;
    border-radius: 3px;
  }
  
  &::-webkit-scrollbar-thumb:hover {
    background: #999;
  }
`;

const StyledTree = styled(Tree)`
  .ant-tree-treenode {
    padding: 2px 0;
  }
  
  .ant-tree-node-content-wrapper {
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.2s;
    cursor: pointer;
    
    &:hover {
      background: #f5f5f5;
    }
  }
  
  .ant-tree-node-selected .ant-tree-node-content-wrapper {
    background: #e6f7ff;
    border: 1px solid #91d5ff;
  }
  
  .ant-tree-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    width: 100%;
  }
  
  .ant-tree-switcher {
    color: #1890ff;
  }
`;

const PageNumber = styled.span`
  color: #8c8c8c;
  font-size: 12px;
  margin-left: auto;
`;

/**
 * PDF书签面板组件
 * 显示PDF的书签/大纲结构，点击可跳转到对应页面
 * 
 * @param {string} pdfFilePath - PDF文件路径（Electron环境）
 * @param {File|Blob} pdfFile - PDF文件对象（Web环境）
 * @param {number} currentPage - 当前页码
 * @param {function} onPageChange - 页面切换回调函数
 */
const BookmarkPanel = ({ pdfFilePath, pdfFile, currentPage, onPageChange }) => {
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [treeData, setTreeData] = useState([]);
  const [expandedKeys, setExpandedKeys] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [lastLoadedPath, setLastLoadedPath] = useState(null);

  // 加载PDF书签
  useEffect(() => {
    if (!pdfFilePath && !pdfFile) {
      setBookmarks([]);
      setTreeData([]);
      setLastLoadedPath(null);
      return;
    }

    // 避免重复加载同一个PDF的书签
    const currentIdentifier = pdfFilePath || (pdfFile?.name || 'unknown');
    if (currentIdentifier === lastLoadedPath) {
      return;
    }

    loadBookmarks();
  }, [pdfFilePath, pdfFile]);

  // 当前页变化时，更新选中的书签
  useEffect(() => {
    if (currentPage && bookmarks.length > 0) {
      updateSelectedBookmark(currentPage);
    }
  }, [currentPage, bookmarks]);

  const loadBookmarks = async () => {
    setLoading(true);
    try {
      let result;

      // 检查是否在Electron环境
      if (window.electronAPI && window.electronAPI.getPDFBookmarks && pdfFilePath) {
        // Electron桌面环境：通过IPC调用
        console.log('📚 [Electron] 通过IPC获取书签');
        result = await window.electronAPI.getPDFBookmarks(pdfFilePath);
      } else {
        // Web环境：通过HTTP API上传文件获取书签
        console.log('🌐 [Web] 通过HTTP API获取书签');
        
        // 从配置文件获取OCR服务端口
        const configResponse = await fetch('./app-config.json');
        if (!configResponse.ok) {
          throw new Error('无法读取配置文件app-config.json');
        }
        
        const config = await configResponse.json();
        const port = config.ocr_server_port;
        const ocrServerUrl = buildOcrServerUrl(config.ocr_server_host, port);
        
        if (!port) {
          throw new Error('配置文件中缺少OCR服务端口信息');
        }

        // Web环境：如果有文件路径，尝试用路径方式
        if (pdfFilePath && !pdfFilePath.startsWith('blob:')) {
          const apiUrl = `${ocrServerUrl}/api/pdf/bookmarks`;
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ pdf_path: pdfFilePath })
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          result = await response.json();
        } 
        // Web环境：如果有文件对象，使用上传方式
        else if (pdfFile) {
          const apiUrl = `${ocrServerUrl}/api/pdf/bookmarks-upload`;
          const formData = new FormData();
          formData.append('pdf_file', pdfFile);

          const response = await fetch(apiUrl, {
            method: 'POST',
            body: formData
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          result = await response.json();
        } else {
          console.warn('⚠️ 无法获取PDF文件');
          message.warning('无法获取PDF文件');
          setBookmarks([]);
          setTreeData([]);
          setLoading(false);
          return;
        }
      }
      
      if (result.success && result.bookmarks && result.bookmarks.length > 0) {
        setBookmarks(result.bookmarks);
        setLastLoadedPath(pdfFilePath || (pdfFile?.name || 'unknown'));
        
        // 转换为Tree组件需要的数据格式
        const treeNodes = convertBookmarksToTreeData(result.bookmarks);
        setTreeData(treeNodes);
        
        // 默认展开第一层
        const firstLevelKeys = treeNodes.map(node => node.key);
        setExpandedKeys(firstLevelKeys);
        
        // 选中当前页对应的书签
        updateSelectedBookmark(currentPage);
        
        console.log(`✅ 成功加载 ${result.bookmarks.length} 个书签`);
        message.success(`加载了 ${result.bookmarks.length} 个书签`);
      } else {
        setBookmarks([]);
        setTreeData([]);
        setLastLoadedPath(pdfFilePath || (pdfFile?.name || 'unknown'));
        console.log('ℹ️ 此PDF没有书签');
        message.info('此PDF没有书签');
      }
    } catch (error) {
      console.error('加载书签失败:', error);
      message.error('加载书签失败: ' + error.message);
      setBookmarks([]);
      setTreeData([]);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 将书签数据转换为Tree组件的数据格式
   */
  const convertBookmarksToTreeData = (bookmarkList, parentKey = '') => {
    return bookmarkList.map((bookmark, index) => {
      const key = parentKey ? `${parentKey}-${index}` : `${index}`;
      const node = {
        key,
        title: (
          <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
            <FileTextOutlined style={{ marginRight: 6, color: '#1890ff' }} />
            <span style={{ flex: 1 }}>{bookmark.title}</span>
            {bookmark.page && (
              <PageNumber>第 {bookmark.page} 页</PageNumber>
            )}
          </div>
        ),
        page: bookmark.page,
        level: bookmark.level || 0,
        isLeaf: !bookmark.children || bookmark.children.length === 0
      };

      // 递归处理子书签
      if (bookmark.children && bookmark.children.length > 0) {
        node.children = convertBookmarksToTreeData(bookmark.children, key);
      }

      return node;
    });
  };

  /**
   * 根据当前页码更新选中的书签
   */
  const updateSelectedBookmark = (pageNum) => {
    if (!pageNum || bookmarks.length === 0) {
      setSelectedKeys([]);
      return;
    }

    // 查找当前页对应的书签
    const findBookmarkKey = (bookmarkList, parentKey = '') => {
      for (let i = 0; i < bookmarkList.length; i++) {
        const bookmark = bookmarkList[i];
        const key = parentKey ? `${parentKey}-${i}` : `${i}`;

        // 如果当前书签的页码匹配，返回key
        if (bookmark.page === pageNum) {
          return key;
        }

        // 如果当前页在两个书签之间，选择前一个书签
        if (i < bookmarkList.length - 1) {
          const nextBookmark = bookmarkList[i + 1];
          if (bookmark.page <= pageNum && nextBookmark.page > pageNum) {
            return key;
          }
        }

        // 递归查找子书签
        if (bookmark.children && bookmark.children.length > 0) {
          const childKey = findBookmarkKey(bookmark.children, key);
          if (childKey) return childKey;
        }
      }
      return null;
    };

    const matchedKey = findBookmarkKey(bookmarks);
    if (matchedKey) {
      setSelectedKeys([matchedKey]);
      
      // 展开到匹配的书签
      const keysToExpand = [];
      const parts = matchedKey.split('-');
      for (let i = 1; i <= parts.length; i++) {
        keysToExpand.push(parts.slice(0, i).join('-'));
      }
      setExpandedKeys(prev => [...new Set([...prev, ...keysToExpand])]);
    }
  };

  /**
   * 点击书签跳转到对应页面
   */
  const handleBookmarkSelect = (selectedKeys, info) => {
    if (selectedKeys.length === 0) return;

    const node = info.node;
    if (node.page && onPageChange) {
      onPageChange(node.page);
    }
  };

  /**
   * 展开/收起节点
   */
  const handleExpand = (expandedKeys) => {
    setExpandedKeys(expandedKeys);
  };

  /**
   * 展开所有书签
   */
  const expandAll = () => {
    const getAllKeys = (nodes, keys = []) => {
      nodes.forEach(node => {
        keys.push(node.key);
        if (node.children) {
          getAllKeys(node.children, keys);
        }
      });
      return keys;
    };
    const allKeys = getAllKeys(treeData);
    setExpandedKeys(allKeys);
  };

  /**
   * 收起所有书签
   */
  const collapseAll = () => {
    setExpandedKeys([]);
  };

  if (loading) {
    return (
      <BookmarkContainer>
        <BookmarkHeader>
          <BookOutlined />
          <span>书签</span>
        </BookmarkHeader>
        <BookmarkContent>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
            <Spin tip="加载书签中..." />
          </div>
        </BookmarkContent>
      </BookmarkContainer>
    );
  }

  if (treeData.length === 0 && !loading) {
    return (
      <BookmarkContainer>
        <BookmarkHeader>
          <BookOutlined />
          <span>书签</span>
        </BookmarkHeader>
        <BookmarkContent>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="此PDF没有书签"
            style={{ marginTop: 60 }}
          />
        </BookmarkContent>
      </BookmarkContainer>
    );
  }

  // 计算总书签数（包括所有层级）
  const countTotalBookmarks = (bookmarkList) => {
    let count = bookmarkList.length;
    bookmarkList.forEach(bookmark => {
      if (bookmark.children && bookmark.children.length > 0) {
        count += countTotalBookmarks(bookmark.children);
      }
    });
    return count;
  };

  const totalBookmarkCount = countTotalBookmarks(bookmarks);

  return (
    <BookmarkContainer>
      <BookmarkHeader>
        <BookmarkTitle>
          <BookOutlined />
          <span>书签 ({totalBookmarkCount})</span>
        </BookmarkTitle>
        <Space size={4}>
          <Tooltip title="展开所有">
            <Button
              type="text"
              size="small"
              icon={<ExpandOutlined />}
              onClick={expandAll}
              style={{ padding: '4px 8px' }}
            />
          </Tooltip>
          <Tooltip title="收起所有">
            <Button
              type="text"
              size="small"
              icon={<ShrinkOutlined />}
              onClick={collapseAll}
              style={{ padding: '4px 8px' }}
            />
          </Tooltip>
        </Space>
      </BookmarkHeader>
      <BookmarkContent>
        <StyledTree
          treeData={treeData}
          expandedKeys={expandedKeys}
          selectedKeys={selectedKeys}
          onSelect={handleBookmarkSelect}
          onExpand={handleExpand}
          showLine={{ showLeafIcon: false }}
          showIcon={false}
        />
      </BookmarkContent>
    </BookmarkContainer>
  );
};

export default BookmarkPanel;
