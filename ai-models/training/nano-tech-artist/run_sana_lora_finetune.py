"""
Nano-Tech Artist 단계 2 — Sana-0.6B LoRA 파인튜닝 실행 스크립트.

diffusers가 공식 제공하는 examples/dreambooth/train_dreambooth_lora_sana.py를
그대로 사용한다 (직접 학습 루프를 재구현하지 않음 — Sana의 정확한 loss 구성,
노이즈 스케줄러 설정 등은 공식 구현을 따르는 것이 안전하다).

이름은 "dreambooth" 스크립트이지만, --dataset_name과 --caption_column="text"를
쓰면 이미지마다 다른 캡션으로 학습하는 일반적인 text-to-image LoRA 파인튜닝으로
동작한다 (고정된 instance_prompt 하나만 쓰는 것이 아님). 우리가 만든
prepare_sana_captions.py의 출력(imagefolder 형식, text 컬럼)이 정확히 이 형태다.

주의: 이 스크립트는 diffusers를 소스에서 설치해야 하고(예제 스크립트는 pip 패키지에
포함되지 않음), huggingface.co 접근이 필요하다. 로컬 개발 샌드박스에서는 네트워크
제약으로 실행 검증이 불가능했다 (docs/15-stage2-pretrained-finetuning.md 5절 참조).
데이터 준비 단계(generate_dataset.py, prepare_sana_captions.py)까지는 이 저장소에서
실제로 검증되었다.

사용법 (Colab, diffusers를 소스 설치한 뒤):
    python run_sana_lora_finetune.py \
        --dataset-dir data/sana_finetune \
        --output-dir checkpoints/sana-lora \
        --base-model Efficient-Large-Model/Sana_600M_512px_diffusers
"""
import argparse
import os
import subprocess
import sys


def find_diffusers_dreambooth_script() -> str:
    """
    diffusers를 소스에서 설치했을 때 생기는 examples/dreambooth/train_dreambooth_lora_sana.py
    경로를 찾는다. Colab에서는 보통 !git clone https://github.com/huggingface/diffusers 로
    받으므로, 그 경로를 우선 확인한다.
    """
    candidates = [
        "diffusers/examples/dreambooth/train_dreambooth_lora_sana.py",
        os.path.expanduser("~/diffusers/examples/dreambooth/train_dreambooth_lora_sana.py"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    raise FileNotFoundError(
        "train_dreambooth_lora_sana.py를 찾을 수 없습니다. "
        "먼저 `git clone https://github.com/huggingface/diffusers` 로 diffusers 소스를 받으세요."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Sana LoRA 파인튜닝 실행 래퍼")
    parser.add_argument("--dataset-dir", type=str, default="data/sana_finetune",
                         help="prepare_sana_captions.py의 출력 디렉토리 (imagefolder 형식)")
    parser.add_argument("--output-dir", type=str, default="checkpoints/sana-lora")
    parser.add_argument("--base-model", type=str,
                         default="Efficient-Large-Model/Sana_600M_512px_diffusers")
    parser.add_argument("--resolution", type=int, default=512)
    parser.add_argument("--train-batch-size", type=int, default=1)
    parser.add_argument("--gradient-accumulation-steps", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--max-train-steps", type=int, default=1000)
    parser.add_argument("--validation-prompt", type=str,
                         default="a purple triangle on a white background")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    script_path = find_diffusers_dreambooth_script()
    print(f"diffusers 학습 스크립트 사용: {script_path}")

    if not os.path.isdir(args.dataset_dir):
        raise FileNotFoundError(
            f"{args.dataset_dir}를 찾을 수 없습니다. 먼저 다음을 실행하세요:\n"
            f"  python generate_dataset.py --out data/shapes --count 6000\n"
            f"  python prepare_sana_captions.py --shapes-dir data/shapes --out {args.dataset_dir}"
        )

    os.makedirs(args.output_dir, exist_ok=True)

    cmd = [
        "accelerate", "launch", script_path,
        f"--pretrained_model_name_or_path={args.base_model}",
        f"--dataset_name={args.dataset_dir}",
        "--caption_column=text",
        f"--output_dir={args.output_dir}",
        "--mixed_precision=bf16",
        f"--resolution={args.resolution}",
        f"--train_batch_size={args.train_batch_size}",
        f"--gradient_accumulation_steps={args.gradient_accumulation_steps}",
        "--use_8bit_adam",
        f"--learning_rate={args.learning_rate}",
        "--lr_scheduler=constant",
        "--lr_warmup_steps=0",
        f"--max_train_steps={args.max_train_steps}",
        f"--validation_prompt={args.validation_prompt}",
        "--validation_epochs=25",
        f"--seed={args.seed}",
        # 체크포인트 재개: Colab 세션이 끊겨도 이어서 학습 가능 (docs/02-training-pipeline.md 원칙).
        # diffusers 예제 스크립트는 --resume_from_checkpoint=latest를 지원한다.
        #
        # 알려진 리스크 (실제 diffusers GitHub 이슈로 확인됨, 2026-09 기준):
        #   - fp16으로 학습 중 재개 시 "Attempting to unscale FP16 gradients" 에러가 보고된 바
        #     있다 (issue #5004). 우리는 bf16을 쓰므로 이 버그의 직접 영향은 받지 않지만,
        #     bf16 미지원 GPU(오래된 세대)에서 fp16으로 강제 전환해야 한다면 이 문제를 만날 수 있다.
        #   - SDXL 버전에서는 재개 후 학습이 멈춘 것처럼 보이는(가중치가 갱신되지 않는) 버그도
        #     보고된 바 있다 (issue #5840). Sana 버전에서 동일 문제가 있는지는 확인되지 않았다.
        #   => 재개가 의심스러우면, 재개 직후 몇 step의 loss를 재개 전과 비교해 실제로 학습이
        #      진행되는지 확인할 것. 문제가 있으면 diffusers 최신 버전으로 갱신 후 재시도.
        "--checkpointing_steps=100",
        "--resume_from_checkpoint=latest",
    ]

    print("실행 명령:")
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
