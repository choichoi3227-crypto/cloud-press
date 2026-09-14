import torch
from fastapi import APIRouter

from config import FLASH_TEXTER_VERSION, NANO_TECH_ARTIST_VERSION
from models import flash_texter, nano_tech_artist

router = APIRouter()


@router.get("")
def health():
    return {
        "status": "ok",
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "loaded_models": {
            "flash_texter": {
                "version": FLASH_TEXTER_VERSION,
                "ready": flash_texter.is_ready(),
            },
            "nano_tech_artist": {
                "version": NANO_TECH_ARTIST_VERSION,
                "ready": nano_tech_artist.is_ready(),
            },
        },
    }
