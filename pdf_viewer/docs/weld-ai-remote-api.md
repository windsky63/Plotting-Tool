# 远端焊点 AI 服务接口约定

模型训练和推理只能部署在内网远端设备。落图客户端默认连接
`http://192.168.32.61:8767`，地址可通过 `public/app-config.json` 的
`weld_ai_server_url` 修改。

## 健康检查

`GET /api/weld-ai/health`

```json
{
  "status": "ready",
  "available": true,
  "modelLoaded": true,
  "modelVersion": "shenyuan-weld-v1"
}
```

服务可接收训练样本但尚未装载模型时，`available` 可为 `true`，
`modelLoaded` 必须为 `false`。客户端此时仍使用现有规则识别。

## 提交推理任务

`POST /api/weld-ai/jobs`

请求包含项目、PDF身份、页码、PDF原始页面尺寸、归一化焊点区域及该区域的
PNG Data URL。远端负责按 1024～1280 像素、约 20% 重叠切片并去重。

服务可以直接返回完成结果，也可以返回异步任务：

```json
{ "jobId": "job-1", "status": "queued" }
```

客户端随后轮询 `GET /api/weld-ai/jobs/{jobId}`。完成结果格式：

```json
{
  "status": "done",
  "modelVersion": "shenyuan-weld-v1",
  "detections": [
    {
      "id": "det-1",
      "xNorm": 0.4521,
      "yNorm": 0.3187,
      "confidence": 0.97,
      "class": "weld"
    }
  ]
}
```

`xNorm/yNorm` 必须相对于完整PDF页面，而不是切片或焊点区域。兼容情况下也可
返回区域图像像素坐标 `x/y`，客户端会根据请求中的区域信息换算。

## 确认训练样本

`POST /api/weld-ai/training-samples/confirm`

一次请求只提交一页，包括原始PDF页面PNG和人工确认后的焊点中心。标签坐标为
完整PDF页面归一化坐标。`sampleId` 用于幂等更新：相同ID再次提交时必须用最新
图像和标签覆盖该页旧版本，不得产生重复样本。这样人工再次修正位置后可以更新真值。

远端应保存：

- 原始页面图像、项目和PDF身份；
- 页码、页面尺寸、确认时间；
- 焊点中心、稳定标识及人工/自动来源；
- 数据集版本和后续训练所使用的模型版本。

客户端只有在使用者点击“确认训练样本”后才调用该接口。连接失败的单页样本会
保存在浏览器 IndexedDB 待传队列，并在下一次明确提交且远端恢复后重试。

## 服务要求

- 允许落图站点跨域访问，支持 `GET/POST/OPTIONS`。
- 推理和训练任务必须使用不同队列；训练不得阻塞在线推理。
- 推理缓存键至少包含PDF身份、页码、识别区域和模型版本。
- 模型异常、任务超时或结果格式错误时返回明确错误，不得返回伪造空成功结果。
