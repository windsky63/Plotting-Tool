# 新电脑部署（仅网页端）

## 1. 一键初始化
在项目根目录运行：

```bat
setup_new_machine_web.bat
```

这个脚本会完成：
- `npm install`
- 创建 `ocr_server\.venv311` 并安装 OCR 依赖
- 创建 `mineru\.venv311` 并安装 MinerU 依赖

## 2. 启动服务
先启动 OCR：

```bat
ocr_server\python\start_ocr_server_venv311.bat
```

再启动网页前端：

```bat
npm start
```

可选：启动 MinerU：

```bat
cd mineru
.venv311\Scripts\python.exe app.py
```

## 3. 健康检查
- OCR: `http://127.0.0.1:8766/health`
- MinerU: `http://127.0.0.1:8081/health`
- 前端: `http://localhost:3004`

## 4. 常见问题
- 缺少 Python 3.11：先安装 Python 3.11 再运行初始化脚本。
- `pip` 下载失败：脚本已自动尝试清华镜像重试。
- OCR 启动后不通：等待 10-30 秒（首次模型加载较慢）。
