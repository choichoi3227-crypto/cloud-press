"""
학습된 Nano-Tech Artist Generator로 조건부 이미지를 생성하는 추론 인터페이스.
inference-server/models/nano_tech_artist.py 가 이 모듈을 로드하여 사용한다.

이 파일의 함수 시그니처(generate_image)는 로드맵의 단계가 올라가도
동일하게 유지하여, 추론 서버 쪽 코드를 바꾸지 않고 모델만 교체할 수 있게 한다.
"""
import base64
import io

import torch

from dataset import condition_to_onehot
from model import NOISE_DIM, Generator

_generator: Generator | None = None
_device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_generator(weights_path: str) -> Generator:
    global _generator
    gen = Generator()
    state = torch.load(weights_path, map_location=_device)
    gen.load_state_dict(state)
    gen.eval()
    gen.to(_device)
    _generator = gen
    return gen


def _tensor_to_png_bytes(img_tensor: torch.Tensor) -> bytes:
    from PIL import Image

    t = (img_tensor.clamp(-1, 1) + 1) / 2 * 255
    arr = t.permute(1, 2, 0).byte().cpu().numpy()
    img = Image.fromarray(arr)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def generate_image(color: str, shape: str, seed: int | None = None) -> bytes:
    """조건(color, shape)에 맞는 이미지를 생성해 PNG 바이트로 반환한다."""
    if _generator is None:
        raise RuntimeError("Generator가 로드되지 않았습니다. load_generator()를 먼저 호출하세요.")

    if seed is not None:
        torch.manual_seed(seed)

    cond = condition_to_onehot(color, shape).unsqueeze(0).to(_device)
    noise = torch.randn(1, NOISE_DIM, device=_device)
    with torch.no_grad():
        img_tensor = _generator(noise, cond)[0]
    return _tensor_to_png_bytes(img_tensor)


def generate_image_base64(color: str, shape: str, seed: int | None = None) -> str:
    png_bytes = generate_image(color, shape, seed=seed)
    return base64.b64encode(png_bytes).decode("ascii")
