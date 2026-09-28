"""Train remotely from manually confirmed samples. Never run this on the annotation PC."""
import argparse, hashlib, json, random
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset

from model import WeldHeatmapNet

TILE, OVERLAP, SIGMA = 1280, 256, 5.0


def sample_key(metadata):
    document = metadata.get('document', {})
    return ':'.join(str(document.get(key, '')) for key in ('name', 'size', 'lastModified'))


def collect_samples(root):
    samples = []
    for labels_path in Path(root).rglob('labels.json'):
        image_path = labels_path.with_name('page.png')
        if not image_path.exists():
            continue
        metadata = json.loads(labels_path.read_text(encoding='utf-8'))
        samples.append({'image': image_path, 'metadata': metadata, 'group': sample_key(metadata)})
    return samples


def split_by_pdf(samples):
    groups = sorted({sample['group'] for sample in samples})
    random.Random(20260902).shuffle(groups)
    train_end, validation_end = int(len(groups) * .70), int(len(groups) * .85)
    groups = {'train': set(groups[:train_end]), 'validation': set(groups[train_end:validation_end]), 'test': set(groups[validation_end:])}
    return {name: [sample for sample in samples if sample['group'] in allowed] for name, allowed in groups.items()}


def heatmap(points):
    output = np.zeros((TILE, TILE), dtype=np.float32)
    radius = int(SIGMA * 3)
    for point_x, point_y in points:
        left, right = max(0, int(point_x) - radius), min(TILE, int(point_x) + radius + 1)
        top, bottom = max(0, int(point_y) - radius), min(TILE, int(point_y) + radius + 1)
        y, x = np.ogrid[top:bottom, left:right]
        output[top:bottom, left:right] = np.maximum(output[top:bottom, left:right], np.exp(-((x - point_x) ** 2 + (y - point_y) ** 2) / (2 * SIGMA ** 2)))
    return output


class WeldTileDataset(Dataset):
    def __init__(self, samples, tiles_per_page=6):
        self.samples, self.tiles_per_page = samples, tiles_per_page
    def __len__(self): return len(self.samples) * self.tiles_per_page
    def __getitem__(self, index):
        sample = self.samples[index % len(self.samples)]
        image = Image.open(sample['image']).convert('RGB')
        width, height = image.size
        labels = sample['metadata'].get('labels', [])
        points = [(float(item['center']['xNorm']) * width, float(item['center']['yNorm']) * height) for item in labels if item.get('center')]
        # Most training crops contain a known weld; remaining crops are random negatives.
        if points and random.random() < .70:
            point_x, point_y = random.choice(points)
            left = int(max(0, min(width - TILE, point_x - random.randint(0, TILE - 1))))
            top = int(max(0, min(height - TILE, point_y - random.randint(0, TILE - 1))))
        else:
            left, top = random.randint(0, max(0, width - TILE)), random.randint(0, max(0, height - TILE))
        tile = Image.new('RGB', (TILE, TILE), 'white'); tile.paste(image.crop((left, top, min(width, left + TILE), min(height, top + TILE))))
        targets = [(x - left, y - top) for x, y in points if left <= x < left + TILE and top <= y < top + TILE]
        source = torch.from_numpy(np.asarray(tile, dtype=np.float32).transpose(2, 0, 1) / 255.0)
        return source, torch.from_numpy(heatmap(targets)).unsqueeze(0)


def train_epoch(model, loader, optimizer, device):
    model.train(); total = 0.0
    for image, target in loader:
        image, target = image.to(device), target.to(device)
        loss = F.binary_cross_entropy_with_logits(model(image), target)
        optimizer.zero_grad(); loss.backward(); optimizer.step(); total += float(loss)
    return total / max(1, len(loader))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True, help='WELD_AI_DATA_DIR/confirmed_samples')
    parser.add_argument('--output', required=True, help='target checkpoint .pt')
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--batch-size', type=int, default=2)
    args = parser.parse_args()
    samples = collect_samples(args.data)
    if len(samples) < 20: raise SystemExit('need at least 20 confirmed pages before training')
    split = split_by_pdf(samples)
    if not split['train'] or not split['validation'] or not split['test']: raise SystemExit('need at least 3 different PDFs for PDF-level split')
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = WeldHeatmapNet().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=1e-4)
    train_loader = DataLoader(WeldTileDataset(split['train']), batch_size=args.batch_size, shuffle=True, num_workers=2, pin_memory=device.type == 'cuda')
    validation_loader = DataLoader(WeldTileDataset(split['validation'], 2), batch_size=args.batch_size, num_workers=2)
    best, output = float('inf'), Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        training_loss = train_epoch(model, train_loader, optimizer, device)
        with torch.no_grad(): validation_loss = sum(F.binary_cross_entropy_with_logits(model(image.to(device)), target.to(device)).item() for image, target in validation_loader) / max(1, len(validation_loader))
        print(json.dumps({'epoch': epoch, 'trainingLoss': training_loss, 'validationLoss': validation_loss}))
        if validation_loss < best:
            best = validation_loss
            torch.save({'model': model.state_dict(), 'modelVersion': f'weld-center-v1-e{epoch}', 'validationLoss': best, 'split': {name: len(value) for name, value in split.items()}}, output)


if __name__ == '__main__': main()
