"""합성 도형 데이터셋을 PyTorch Dataset으로 로드한다."""
import json
import os

import torch
from PIL import Image
from torch.utils.data import Dataset
from torchvision import transforms

from model import NUM_COLORS, NUM_SHAPES

COLOR_TO_IDX = {
    "red": 0,
    "blue": 1,
    "green": 2,
    "yellow": 3,
    "purple": 4,
    "black": 5,
}
SHAPE_TO_IDX = {"circle": 0, "square": 1, "triangle": 2}


def condition_to_onehot(color: str, shape: str) -> torch.Tensor:
    vec = torch.zeros(NUM_COLORS + NUM_SHAPES)
    vec[COLOR_TO_IDX[color]] = 1.0
    vec[NUM_COLORS + SHAPE_TO_IDX[shape]] = 1.0
    return vec


class ShapesDataset(Dataset):
    def __init__(self, data_dir: str, image_size: int = 64):
        self.data_dir = data_dir
        with open(os.path.join(data_dir, "labels.json"), encoding="utf-8") as f:
            meta = json.load(f)
        self.samples = meta["samples"]
        self.transform = transforms.Compose(
            [
                transforms.Resize((image_size, image_size)),
                transforms.ToTensor(),
                transforms.Normalize([0.5] * 3, [0.5] * 3),  # [-1, 1] 범위로 정규화 (Tanh 출력과 맞춤)
            ]
        )

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        sample = self.samples[idx]
        img_path = os.path.join(self.data_dir, "images", sample["file"])
        img = Image.open(img_path).convert("RGB")
        img_tensor = self.transform(img)
        cond = condition_to_onehot(sample["color"], sample["shape"])
        return img_tensor, cond
