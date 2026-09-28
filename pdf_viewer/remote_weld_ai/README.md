# 远端焊点 AI 服务

本目录只部署到内网 GPU 电脑。落图电脑不训练、不加载权重。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
$env:WELD_AI_DATA_DIR = 'D:\weld-ai-data'
uvicorn app:app --host 0.0.0.0 --port 8767
```

权重路径默认为 `D:\weld-ai-data\models\weld-center-v1.pt`。没有权重时健康检查返回
`available: true`、`modelLoaded: false`，客户端继续用规则识别，绝不返回伪成功结果。

服务只返回焊点候选中心、置信度和模型版本；候选由客户端以红点显示并由人工采纳，服务不编号、不生成最终标注。
训练样本由“确认焊点训练样本”上传；同一 `sampleId` 重新上传会覆盖旧样本。

首批样本达到至少 300 页、3,000 个经人工核对的焊点且覆盖至少 3 个 PDF 后，在 GPU 电脑运行：

```powershell
.\.venv\Scripts\python train.py --data D:\weld-ai-data\confirmed_samples --output D:\weld-ai-data\models\weld-center-v1.pt
```

训练按 PDF（而不是页）拆分为训练、验证、独立测试集合。训练完成后重启 8767 服务加载新权重；先使用未参与训练的图纸灰度验证候选召回率，AI 候选仍需人工采纳。
