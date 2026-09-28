# 快速打包指南

## 🚀 一键打包（推荐）

### Windows 用户

双击运行 `build.bat` 文件，然后按照提示操作。

### 所有平台

```bash
npm run build-electron
```

## 📋 打包步骤详解

### 第一步：安装依赖（首次运行）

```bash
npm install
```

### 第二步：运行打包前检查

```bash
npm run pre-build-check
```

这个命令会检查：
- ✅ 所有必需的文件是否存在
- ✅ OCR服务器是否完整
- ✅ 依赖包是否安装
- ✅ 配置文件是否正确

### 第三步：开始打包

```bash
# 完整打包（所有格式）
npm run build-electron

# 或使用备用命令
npm run electron-pack
```

## 📦 打包输出

打包完成后，在 `dist` 目录下：

```
dist/
├── nsis-1.0.0.exe                              # Windows安装包
├── PDF单线图焊口预制标注工具-便捷版-1.0.0.exe      # 便携版
└── win-unpacked/                               # 解压版
    └── PDF单线图焊口预制标注工具.exe
```

## 🎯 选择打包目标

### 只打包特定格式

```bash
# 只打包安装包
npx electron-builder --win nsis

# 只打包便携版
npx electron-builder --win portable

# 只打包解压版
npx electron-builder --win dir
```

## ⚡ 常见问题

### 问：打包时间很长？

**答：** 首次打包需要下载 Electron 二进制文件（约 100-200MB），后续打包会快很多。

### 问：打包失败提示找不到文件？

**答：** 运行 `npm run pre-build-check` 检查所有必需文件是否存在。

### 问：如何减小打包文件大小？

**答：** 当前配置已经优化：
- 使用 asar 压缩
- 排除开发依赖
- 只包含必需文件

### 问：打包后OCR功能不可用？

**答：** 检查以下内容：
1. `ocr_server/ocr_server.exe` 是否存在
2. `ocr_server/models/` 目录是否完整
3. `public/app-config.json` 配置是否正确

### 问：打包后应用无法启动？

**答：** 
1. 检查 `app.ico` 文件是否存在
2. 确认所有 preload 脚本都已打包
3. 查看控制台错误信息

## 📊 打包大小参考

- **安装包**: 约 200-300 MB
- **便携版**: 约 200-300 MB  
- **解压版**: 约 300-400 MB

## 🔄 更新版本号

在 `package.json` 中修改版本号：

```json
{
  "version": "1.0.1"  // 从 1.0.0 改为 1.0.1
}
```

然后重新打包即可。

## 📝 更多信息

详细打包指南请查看 [BUILD_GUIDE.md](BUILD_GUIDE.md)

---

**祝打包顺利！** 🎉

