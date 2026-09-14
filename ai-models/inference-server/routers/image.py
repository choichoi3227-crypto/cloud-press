from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import verify_internal_request
from config import NANO_TECH_ARTIST_VERSION
from models import nano_tech_artist

router = APIRouter(dependencies=[Depends(verify_internal_request)])

VALID_COLORS = {"red", "blue", "green", "yellow", "purple", "black"}
VALID_SHAPES = {"circle", "square", "triangle"}


class ImageGenerateRequest(BaseModel):
    prompt_type: Literal["condition", "text"]
    color: Optional[str] = None
    shape: Optional[str] = None
    prompt: Optional[str] = None


class ImageGenerateResponse(BaseModel):
    model: str
    image_base64: str
    format: str = "png"


@router.post("/generate", response_model=ImageGenerateResponse)
def generate(req: ImageGenerateRequest) -> ImageGenerateResponse:
    if req.prompt_type == "condition":
        if req.color not in VALID_COLORS or req.shape not in VALID_SHAPES:
            raise HTTPException(status_code=400, detail="invalid color or shape")
        image_b64 = nano_tech_artist.generate_image(color=req.color, shape=req.shape)
    else:
        # 단계 3(텍스트 프롬프트 기반)은 아직 미구현.
        raise HTTPException(status_code=501, detail="text-to-image not yet implemented (roadmap milestone 3)")

    return ImageGenerateResponse(
        model=f"nano-tech-artist-{NANO_TECH_ARTIST_VERSION}",
        image_base64=image_b64,
    )
