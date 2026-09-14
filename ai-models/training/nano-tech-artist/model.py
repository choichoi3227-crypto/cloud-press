"""
Nano-Tech Artist 단계 1 — Conditional GAN (cGAN) 모델 정의.

조건(색상 원-핫 + 도형 원-핫)을 노이즈와 함께 Generator에 넣어
해당 조건에 맞는 도형 이미지를 생성하도록 학습한다.
"""
import torch
import torch.nn as nn

NUM_COLORS = 6
NUM_SHAPES = 3
COND_DIM = NUM_COLORS + NUM_SHAPES  # 9
NOISE_DIM = 100
IMG_SIZE = 64
IMG_CHANNELS = 3


class Generator(nn.Module):
    """노이즈 + 조건 벡터 -> 64x64x3 이미지."""

    def __init__(self, noise_dim: int = NOISE_DIM, cond_dim: int = COND_DIM, feature_maps: int = 64):
        super().__init__()
        input_dim = noise_dim + cond_dim
        self.net = nn.Sequential(
            # (input_dim, 1, 1) -> (fm*8, 4, 4)
            nn.ConvTranspose2d(input_dim, feature_maps * 8, 4, 1, 0, bias=False),
            nn.BatchNorm2d(feature_maps * 8),
            nn.ReLU(True),
            # -> (fm*4, 8, 8)
            nn.ConvTranspose2d(feature_maps * 8, feature_maps * 4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps * 4),
            nn.ReLU(True),
            # -> (fm*2, 16, 16)
            nn.ConvTranspose2d(feature_maps * 4, feature_maps * 2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps * 2),
            nn.ReLU(True),
            # -> (fm, 32, 32)
            nn.ConvTranspose2d(feature_maps * 2, feature_maps, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps),
            nn.ReLU(True),
            # -> (3, 64, 64)
            nn.ConvTranspose2d(feature_maps, IMG_CHANNELS, 4, 2, 1, bias=False),
            nn.Tanh(),
        )

    def forward(self, noise: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        x = torch.cat([noise, cond], dim=1)  # (B, noise_dim+cond_dim)
        x = x.view(x.size(0), x.size(1), 1, 1)
        return self.net(x)


class Discriminator(nn.Module):
    """이미지 + 조건 벡터 -> 진짜/가짜 판별 (조건도 함께 반영하는 conditional discriminator)."""

    def __init__(self, cond_dim: int = COND_DIM, feature_maps: int = 64):
        super().__init__()
        # 조건 벡터를 이미지와 같은 공간 크기로 브로드캐스트하기 위해 채널로 결합
        self.cond_dim = cond_dim
        in_channels = IMG_CHANNELS + cond_dim

        self.net = nn.Sequential(
            # (in_channels, 64, 64) -> (fm, 32, 32)
            nn.Conv2d(in_channels, feature_maps, 4, 2, 1, bias=False),
            nn.LeakyReLU(0.2, inplace=True),
            # -> (fm*2, 16, 16)
            nn.Conv2d(feature_maps, feature_maps * 2, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps * 2),
            nn.LeakyReLU(0.2, inplace=True),
            # -> (fm*4, 8, 8)
            nn.Conv2d(feature_maps * 2, feature_maps * 4, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps * 4),
            nn.LeakyReLU(0.2, inplace=True),
            # -> (fm*8, 4, 4)
            nn.Conv2d(feature_maps * 4, feature_maps * 8, 4, 2, 1, bias=False),
            nn.BatchNorm2d(feature_maps * 8),
            nn.LeakyReLU(0.2, inplace=True),
            # -> (1, 1, 1)
            nn.Conv2d(feature_maps * 8, 1, 4, 1, 0, bias=False),
            nn.Sigmoid(),
        )

    def forward(self, img: torch.Tensor, cond: torch.Tensor) -> torch.Tensor:
        b, _, h, w = img.shape
        cond_map = cond.view(b, self.cond_dim, 1, 1).expand(b, self.cond_dim, h, w)
        x = torch.cat([img, cond_map], dim=1)
        return self.net(x).view(-1, 1).squeeze(1)


def weights_init(m: nn.Module) -> None:
    """DCGAN 논문 권장 초기화."""
    classname = m.__class__.__name__
    if classname.find("Conv") != -1:
        nn.init.normal_(m.weight.data, 0.0, 0.02)
    elif classname.find("BatchNorm") != -1:
        nn.init.normal_(m.weight.data, 1.0, 0.02)
        nn.init.constant_(m.bias.data, 0)
