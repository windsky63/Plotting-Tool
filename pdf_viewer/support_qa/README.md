# 帮助助手接入说明

网页端右下角的“帮助”按钮会请求独立帮助服务的 `/api/support-chat` 接口。帮助服务会读取本目录下的 `faq.md` 和 `manual.md`，再调用 DeepSeek 生成答复。

帮助服务与 OCR 服务分离，不修改 OCR 的识别接口、启动逻辑和任务流程。

## 环境变量

必须在帮助服务端设置：

`DEEPSEEK_API_KEY`

可选：

`DEEPSEEK_MODEL`，默认 `deepseek-chat`

`DEEPSEEK_API_URL`，默认 `https://api.deepseek.com/chat/completions`

`LUOTU_SUPPORT_QA_DIR`，用于指定知识库目录；不设置时会自动从项目目录查找 `support_qa`。

`SUPPORT_CHAT_HOST`，默认 `0.0.0.0`

`SUPPORT_CHAT_PORT`，默认 `8788`

## 启动方式

在项目根目录执行：

`ocr_server\.venv311\Scripts\python.exe support_qa\support_chat_server.py`

## 前端配置

前端通过 `public/app-config.json` 中的 `support_chat_url` 定位帮助服务：

`support_chat_url`

例如：

`"support_chat_url": "http://192.168.32.61:8788"`
