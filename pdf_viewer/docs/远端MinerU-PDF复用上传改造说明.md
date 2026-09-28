# 远端 MinerU：PDF 复用上传改造说明

## 目标

解决落图工具进行“材料表自动识别”时，大型 PDF 被按页切分、重复上传而耗时过长的问题。

保持 **PDF 上传 + MinerU PDF 识别** 的现有识别方式；不改为图片识别，不降低识别精度。改造后，同一份 PDF 在一次使用周期内只上传一次，后续材料表逐页识别只提交文件标识、页码和区域模板。

## 当前前端行为与瓶颈

前端文件：`src/services/ocrService.js`，方法：`runBatchOCRMinerU`。

材料表自动识别目前会逐页调用该方法；浏览器会先将目标页切为小 PDF，再调用：

```http
POST /pdf/recognize
Content-Type: multipart/form-data
pdf_file=<切页 PDF>
template=<JSON>
lang=ch
page_mapping=<JSON>
```

大 PDF 中单页可能仍包含高分辨率图像、字体或共享对象；并且每页和自动重试都会再次上传。因此上传总量和 HTTP 建连次数很高。

## 要实现的远端接口

以下接口应加到 **当前远端 MinerU HTTP 服务**（不是本机生产页面，也不是 OCR 服务）。接口可以沿用现有鉴权、任务队列、日志和 CORS 配置。

### 1. 上传并缓存 PDF

```http
POST /pdf/files
Content-Type: multipart/form-data

pdf_file=<原始 PDF>
client_file_key=<可选，前端计算的稳定指纹>
```

成功响应：

```json
{
  "success": true,
  "file_id": "pdf_01J...",
  "file_name": "xxx.pdf",
  "page_count": 188,
  "size_bytes": 123456789,
  "expires_at": "2026-09-04T10:00:00Z",
  "reused": false
}
```

要求：

- 仅接受 PDF，限制单文件大小与服务磁盘配额；失败需返回清晰错误。
- 以 `client_file_key + 文件大小` 或服务端 SHA-256 去重；同一文件再次上传时返回已有 `file_id`，`reused: true`。
- 文件保存在 MinerU 服务本机的临时目录，不能保存到浏览器或生产网页静态目录。
- 默认有效期建议 24 小时；每次通过 `file_id` 发起识别可续期 24 小时。
- 过期清理任务每小时运行一次；正在被任务使用的文件不可删除。
- 不得把服务器绝对路径、其他用户文件标识或敏感异常信息暴露给前端。

### 2. 以已上传 PDF 提交识别任务

```http
POST /pdf/recognize-by-file-id
Content-Type: application/json

{
  "file_id": "pdf_01J...",
  "template": { "materialArea": {}, "pipelineArea": {}, "pipeClassArea": {}, "pageNumberArea": {}, "columns": [], "dividers": [] },
  "lang": "ch",
  "pages": { "type": "custom", "pages": [17] }
}
```

成功响应必须与现有 `POST /pdf/recognize` 保持一致：

```json
{ "success": true, "job_id": "..." }
```

并继续复用既有：

```http
GET /pdf/job/{job_id}
GET /task/{excel_task_id}/export_excel
```

要求：

- `pages` 使用**原始 PDF 的 1 起始页码**，不用 `page_mapping`。
- 通过 `file_id` 找到缓存 PDF 后，直接进入现有 MinerU 任务队列和识别逻辑；不要重新下载、复制或转发整份文件。
- `file_id` 不存在、过期或已清理时返回 `404`：`{ "success": false, "code": "FILE_NOT_FOUND" }`。
- 服务端应记录上传耗时、文件大小、缓存命中、识别页码、任务耗时，方便排查网络和模型问题。

### 3. 查询和主动释放（建议实现）

```http
GET /pdf/files/{file_id}
DELETE /pdf/files/{file_id}
```

- `GET` 用于前端确认缓存是否还可用。
- `DELETE` 是可选的主动释放；即使前端未调用，过期清理仍必须生效。
- 删除正在执行任务的文件时应返回冲突状态，而不是强制删除。

## 实现建议

1. 将上传文件保存为随机 `file_id` 命名的 `.pdf`，元数据保存为 JSON 或轻量数据库：文件名、大小、哈希、创建/续期时间、引用计数、任务状态。
2. 上传采用流式写盘，不要把大 PDF 一次性读入 Python 内存。
3. 识别任务仅传本地临时路径给既有 MinerU 调用函数；任务完成后减少引用计数。
4. 所有临时文件名必须由服务端生成，禁止直接使用前端传入的路径或文件名。
5. 若当前服务有重启机制，临时目录和元数据应位于容器挂载卷/服务数据目录；服务重启后仍可复用未过期文件。
6. CORS 至少允许落图工具所在页面来源访问 `POST /pdf/files` 和 `POST /pdf/recognize-by-file-id`。

## 验收步骤

1. 用一份大于 100 MB、至少 50 页的真实 PDF 上传两次；第二次应返回相同或等价的缓存文件，且不重新写入完整文件。
2. 用返回的 `file_id` 分别请求第 1、20、50 页；每次请求体不应包含 PDF 二进制数据。
3. 确认轮询结果中材料表逻辑行、QTY、管线号、管道等级、页码与原 `/pdf/recognize` 流程一致。
4. 等待过期或调用删除接口；再次识别应返回 `FILE_NOT_FOUND`，前端随后可自动重新上传一次。
5. 服务重启后，确认未过期缓存是否仍能使用；确认磁盘清理不会删除运行中任务。

## 给前端的对接约定（由本机后续改造）

前端会维护“当前 PDF 指纹 -> `file_id`”的内存/本地缓存映射：

- 首次材料表识别：调用 `/pdf/files` 上传原始 PDF。
- 逐页识别与自动重试：调用 `/pdf/recognize-by-file-id`，仅传对应页码和区域模板。
- 收到 `FILE_NOT_FOUND`：清除旧 `file_id` 并自动重新上传一次，再继续当前页。
- 如果新接口不可用（404/501），前端应安全回退到当前“切页后上传”的流程，保证老服务可继续使用。

前端改造需等本说明中的接口在远端可用后进行；在接口未部署前，不要修改或移除现有 `/pdf/recognize` 调用。

## 非目标

- 不改变 MinerU 模型、OCR 识别参数、材料表字段解析逻辑或结果格式。
- 不改为图片上传。
- 不把大 PDF 常驻在浏览器内存。
- 不影响焊点识别、特殊块识别、矢量提取和标注版 PDF 导出。
