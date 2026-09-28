# 落图工具（Plotting Tool）

落图工具是一套面向工程 PDF 单线图的浏览、识别、标注与导出工具。项目以 React 和 Electron 为主体，结合 PDF.js、OCR 服务和远程 AI 能力，用于辅助完成管线、焊点及相关工程信息的数字化落图工作。

## 核心功能

- PDF 高清渲染、缩放、翻页、搜索和大文档分页缓存
- 焊点、管线、材质、管径等工程信息的标注与管理
- 焊点编号、排序、调整、批量处理和标注规则配置
- OCR 区域识别、模板管理和识别结果可视化
- 管线、弯头、三通、阀门及焊点候选项的智能识别
- 标注撤销/重做、自动保存、草稿恢复和审计日志
- 标注版 PDF、数据表格和焊口表等结果导出
- 可选的远程焊点 AI、MinerU 分图点工具和帮助助手

## 技术栈

- React 19
- Electron 27
- PDF.js 6
- Ant Design / Material UI / styled-components
- Node.js 服务脚本
- Python OCR 与远程 AI 参考服务

## 项目结构

```text
.
├─ idf_mineru_tool/       # MinerU 分图点辅助工具
├─ pdf_viewer/            # 落图工具主应用
│  ├─ public/          # Electron 入口与静态资源
│  ├─ src/             # React 页面、组件、服务与算法
│  ├─ scripts/         # 构建、部署、验证与 PDF 缓存脚本
│  ├─ ocr_server/      # OCR 服务配置
│  ├─ remote_weld_ai/  # 远程焊点 AI 参考实现
│  └─ support_qa/      # 帮助助手与自动保存服务
├─ root_scripts/          # Windows 部署、自启动与网络配置脚本
└─ 文件清单.txt          # 项目交付内容概览
```

## 环境要求

- Windows 10/11（当前部署脚本主要面向 Windows）
- Node.js 18 或更高版本
- npm
- 如需本地 OCR：Python 3.11 及相应模型/依赖

## 快速开始

### 1. 安装前端依赖

```powershell
cd pdf_viewer
npm install
```

### 2. 启动 Web 开发环境

```powershell
npm start
```

默认开发端口为 `3004`。

### 3. 启动 Electron 开发环境

```powershell
npm run electron-dev
```

### 4. 构建项目

```powershell
npm run build
```

构建 Electron 安装包：

```powershell
npm run electron-pack
```

### 5. 运行测试

```powershell
npm test
```

## 生产部署

Windows 环境可在 `pdf_viewer` 目录运行：

```powershell
.\deploy.bat
```

生产服务默认使用 `3005` 端口。部署前请先核对 `public/app-config.json`、OCR 服务地址及各服务端口配置。更多说明见 [`pdf_viewer/docs`](pdf_viewer/docs) 和 [`pdf_viewer/NEW_MACHINE_WEB_QUICKSTART.md`](pdf_viewer/NEW_MACHINE_WEB_QUICKSTART.md)。

## 配置与安全

- 请勿将 API Key、密码、生产环境变量或客户业务 PDF 提交到仓库。
- `.env*`、运行时目录、模型缓存、`node_modules` 和生成的发布包已由 `.gitignore` 排除。
- 建议从示例配置创建本地配置，并通过环境变量或密钥管理服务注入凭据。
- 上传真实图纸前，请确认数据授权和脱敏要求。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动 Web 开发服务 |
| `npm run electron-dev` | 启动 React + Electron 开发环境 |
| `npm run build` | 生成 Web 生产构建 |
| `npm run electron-pack` | 打包 Electron 应用 |
| `npm run serve-prod` | 启动生产 Web 服务 |
| `npm run lint` | 执行代码检查 |
| `npm test` | 运行前端测试 |
| `npm run verify:pdfjs6` | 验证 PDF.js 6 运行环境 |

## 说明

本仓库主要保存源码、配置示例和部署脚本，不包含本地依赖、运行缓存、历史业务 PDF、模型文件及含凭据的内部发布包。
