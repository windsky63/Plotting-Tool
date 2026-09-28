"""GPU-only remote service. It returns candidate centers; it never creates final annotations."""
import asyncio, base64, io, json, os, uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import torch
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
from model import WeldHeatmapNet

ROOT = Path(os.getenv('WELD_AI_DATA_DIR', './data')).resolve()
SAMPLES, WEIGHTS = ROOT / 'confirmed_samples', Path(os.getenv('WELD_AI_WEIGHTS', ROOT / 'models' / 'weld-center-v1.pt'))
DEVICE, TILE, OVERLAP = torch.device('cuda' if torch.cuda.is_available() else 'cpu'), 1280, 256
for path in (SAMPLES, WEIGHTS.parent): path.mkdir(parents=True, exist_ok=True)
MODEL, MODEL_VERSION, JOBS = None, '', {}
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='weld-ai-inference')

app = FastAPI(title='Remote Weld Center AI', version='1.0.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['GET', 'POST', 'OPTIONS'], allow_headers=['Content-Type'])

class ImagePayload(BaseModel):
    mimeType: str = 'image/png'
    dataUrl: str
    width: int
    height: int
    renderScale: float | None = None
class JobPayload(BaseModel):
    project: str = 'unknown'
    document: dict = Field(default_factory=dict)
    page: int
    pageSize: dict
    recognitionArea: dict = Field(default_factory=dict)
    image: ImagePayload
class ConfirmedSample(JobPayload):
    sampleId: str
    confirmedAt: str | None = None
    labels: list[dict] = Field(default_factory=list)

def now(): return datetime.now(timezone.utc).isoformat()
def clean(value): return ''.join(c if c.isalnum() or c in '-_.' else '_' for c in str(value))[:160]
def decode(data_url):
    try: return Image.open(io.BytesIO(base64.b64decode(data_url.split(',', 1)[1]))).convert('RGB')
    except Exception as error: raise ValueError(f'invalid image data URL: {error}') from error
def load_model():
    global MODEL, MODEL_VERSION
    if MODEL is not None: return MODEL
    if not WEIGHTS.exists(): return None
    checkpoint = torch.load(WEIGHTS, map_location=DEVICE, weights_only=False)
    MODEL = WeldHeatmapNet().to(DEVICE)
    MODEL.load_state_dict(checkpoint['model']); MODEL.eval()
    MODEL_VERSION = str(checkpoint.get('modelVersion') or WEIGHTS.stem)
    return MODEL
def origins(length):
    if length <= TILE: return [0]
    result = list(range(0, length - TILE + 1, TILE - OVERLAP)); final = length - TILE
    return result if result[-1] == final else result + [final]
def maxima(heatmap, threshold=.35):
    ys, xs = np.where(heatmap >= threshold); output=[]
    for y, x in zip(ys, xs):
        if 0 < y < heatmap.shape[0]-1 and 0 < x < heatmap.shape[1]-1 and heatmap[y,x] >= heatmap[y-1:y+2,x-1:x+2].max(): output.append((x,y,float(heatmap[y,x])))
    return output
def dedupe(points, distance=20):
    result=[]
    for point in sorted(points, key=lambda item:item[2], reverse=True):
        if all((point[0]-old[0])**2+(point[1]-old[1])**2 >= distance**2 for old in result): result.append(point)
    return result
def infer(payload):
    model = load_model()
    if model is None: raise RuntimeError('model weights are not loaded')
    image=decode(payload.image.dataUrl); width,height=image.size; points=[]
    with torch.inference_mode():
        for top in origins(height):
            for left in origins(width):
                tile=image.crop((left,top,min(width,left+TILE),min(height,top+TILE))); padded=Image.new('RGB',(TILE,TILE),'white'); padded.paste(tile)
                tensor=torch.from_numpy(np.asarray(padded,dtype=np.float32).transpose(2,0,1)/255).unsqueeze(0).to(DEVICE)
                heatmap=torch.sigmoid(model(tensor))[0,0].cpu().numpy()
                points += [(left+x,top+y,score) for x,y,score in maxima(heatmap) if left+x < width and top+y < height]
    return {'modelVersion': MODEL_VERSION, 'detections':[{'id':f'heatmap-{i}','x':round(x,2),'y':round(y,2),'confidence':round(score,4),'class':'weld'} for i,(x,y,score) in enumerate(dedupe(points))]}
async def execute(job_id,payload):
    JOBS[job_id]={'status':'running','updatedAt':now()}
    try:
        result=await asyncio.get_running_loop().run_in_executor(POOL,infer,payload); JOBS[job_id]={'status':'done',**result,'updatedAt':now()}
    except Exception as error: JOBS[job_id]={'status':'error','error':str(error),'updatedAt':now()}

@app.get('/api/weld-ai/health')
async def health():
    model=load_model(); return {'status':'ready' if model else 'waiting_for_model','available':True,'modelLoaded':model is not None,'modelVersion':MODEL_VERSION,'device':str(DEVICE)}
@app.post('/api/weld-ai/jobs')
async def create_job(payload:JobPayload, background_tasks:BackgroundTasks):
    if load_model() is None: raise HTTPException(503,'model weights are not loaded')
    job_id=uuid.uuid4().hex; JOBS[job_id]={'status':'queued','updatedAt':now()}; background_tasks.add_task(execute,job_id,payload); return {'jobId':job_id,'status':'queued'}
@app.get('/api/weld-ai/jobs/{job_id}')
async def read_job(job_id:str):
    if job_id not in JOBS: raise HTTPException(404,'job not found')
    return JOBS[job_id]
@app.post('/api/weld-ai/training-samples/confirm')
async def confirm_sample(sample:ConfirmedSample):
    folder=SAMPLES/clean(sample.project)/clean(sample.sampleId); folder.mkdir(parents=True,exist_ok=True)
    decode(sample.image.dataUrl).save(folder/'page.png','PNG'); data=sample.model_dump(); data['storedAt']=now(); (folder/'labels.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return {'success':True,'sampleId':sample.sampleId,'labelCount':len(sample.labels)}
