import torch
from torch import nn


class Block(nn.Sequential):
    def __init__(self, input_channels, output_channels):
        super().__init__(
            nn.Conv2d(input_channels, output_channels, 3, padding=1), nn.BatchNorm2d(output_channels), nn.ReLU(True),
            nn.Conv2d(output_channels, output_channels, 3, padding=1), nn.BatchNorm2d(output_channels), nn.ReLU(True),
        )


class WeldHeatmapNet(nn.Module):
    """Single-class weld-center heatmap model for 1280px drawing tiles."""
    def __init__(self):
        super().__init__()
        self.one, self.two, self.three = Block(3, 32), Block(32, 64), Block(64, 128)
        self.pool, self.bridge = nn.MaxPool2d(2), Block(128, 256)
        self.up3, self.dec3 = nn.ConvTranspose2d(256, 128, 2, 2), Block(256, 128)
        self.up2, self.dec2 = nn.ConvTranspose2d(128, 64, 2, 2), Block(128, 64)
        self.up1, self.dec1 = nn.ConvTranspose2d(64, 32, 2, 2), Block(64, 32)
        self.head = nn.Conv2d(32, 1, 1)

    def forward(self, value):
        one = self.one(value)
        two = self.two(self.pool(one))
        three = self.three(self.pool(two))
        bridge = self.bridge(self.pool(three))
        three = self.dec3(torch.cat((self.up3(bridge), three), 1))
        two = self.dec2(torch.cat((self.up2(three), two), 1))
        one = self.dec1(torch.cat((self.up1(two), one), 1))
        return self.head(one)
