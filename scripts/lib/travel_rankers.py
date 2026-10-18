"""Small paper-inspired rankers, trained from scratch on cached content features.

DIN-inspired candidate-conditioned attention (softmax adaptation), and the
matrix cross-layer from DCN-V2. No claim of reproducing industrial systems.
"""
import torch
from torch import nn


class DINRanker(nn.Module):
    def __init__(self, features=608, width=64):
        super().__init__()
        self.project = nn.Sequential(nn.Linear(features, width), nn.Tanh())
        self.attention = nn.Sequential(nn.Linear(width*4, 64), nn.Tanh(), nn.Linear(64, 1))
        self.head = nn.Sequential(nn.Linear(width*5, 128), nn.ReLU(), nn.Linear(128, 32), nn.ReLU(), nn.Linear(32, 1))

    def forward(self, profile, candidate, history, mask):
        u, c, h = self.project(profile), self.project(candidate), self.project(history)
        query = c[:, None, :].expand_as(h)
        logits = self.attention(torch.cat([query, h, query-h, query*h], dim=-1)).squeeze(-1)
        # At least one padded slot exists. An all-empty history must give zero,
        # not NaNs, and changes in masked values must never affect the result.
        attention = torch.softmax(logits.masked_fill(~mask, -1e9), dim=1)*mask
        context = (h*attention[:, :, None]).sum(dim=1)
        return self.head(torch.cat([u, c, context, u*c, context*c], dim=-1)).squeeze(-1)


class MatrixCross(nn.Module):
    def __init__(self, width):
        super().__init__()
        self.linear = nn.Linear(width, width)

    def forward(self, base, current):
        return base*self.linear(current)+current


class DCNv2Ranker(nn.Module):
    def __init__(self, features=608, width=64):
        super().__init__()
        self.project = nn.Sequential(nn.Linear(features, width), nn.Tanh())
        size = width*3
        self.cross = nn.ModuleList([MatrixCross(size) for _ in range(2)])
        self.deep = nn.Sequential(nn.Linear(size, 128), nn.ReLU(), nn.Linear(128, 32), nn.ReLU())
        self.head = nn.Linear(size+32, 1)

    def forward(self, profile, candidate, history, mask):
        h = (history*mask[:, :, None]).sum(dim=1)/mask.sum(dim=1, keepdim=True).clamp_min(1)
        base = torch.cat([self.project(profile), self.project(candidate), self.project(h)], dim=-1)
        current = base
        for layer in self.cross:
            current = layer(base, current)
        return self.head(torch.cat([current, self.deep(base)], dim=-1)).squeeze(-1)
