"""
Flash Texter 단계 2 — Qwen3.5-0.8B-Base를 LoRA로 파인튜닝하는 스크립트.
Colab GPU(T4 기준)에서 실행하는 것을 전제로 작성되었다.

중요 (실제 조사로 확인된 사실, 2026-09 기준):
  - Qwen3.5는 transformers >= 5.2.0 부터 지원된다 (그 이전 버전에서는 아예 로드되지
    않는다 — v5.2.0 릴리스 노트에서 확인). requirements.txt를 반드시 이 버전 이상으로
    맞춰야 한다.
  - 알려진 버그: AutoModelForCausalLM.from_pretrained(..., dtype=...)로 Qwen3.5
    계열(특히 멀티모달/composite 체크포인트)을 로드하면 dtype 인자가 조용히
    무시되고 항상 bfloat16으로 로드되는 문제가 실제로 보고되어 있다
    (huggingface/transformers issue #46459). 구체 클래스(Qwen3_5ForCausalLM 등)를
    직접 쓰면 이 버그를 우회할 수 있다고 함께 보고되어 있다. 이 스크립트는 GPU
    학습에서는 bf16을 그대로 쓰므로 이 버그의 영향을 받지 않지만, CPU 추론 실측
    (Colab 노트북 8절)에서 float32로 강제 변환하려 할 때 이 버그를 만날 수 있으니
    실제로 dtype이 의도대로 적용됐는지 로드 후 확인하는 코드를 넣었다.

주의: 이 스크립트는 huggingface.co 접근이 필요하다. 로컬 개발 샌드박스에서는
네트워크 제약으로 실행 검증이 불가능했으므로 (docs/15-stage2-pretrained-finetuning.md
5절 참조), Colab(train_colab_lora.ipynb)에서 실제로 실행해 검증해야 한다.

사용법 (Colab):
    python train_lora.py --data data/prepared/finetune_data.jsonl \
        --base-model Qwen/Qwen3.5-0.8B-Base \
        --checkpoint-dir checkpoints/lora --epochs 3
"""
import argparse
import json
import os

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)

MIN_TRANSFORMERS_VERSION = (5, 2, 0)
SEED = 42


def check_transformers_version() -> None:
    import transformers

    version_parts = transformers.__version__.split(".")[:3]
    try:
        current = tuple(int(p) for p in version_parts)
    except ValueError:
        # dev 버전 등 파싱 불가능한 형식이면 경고만 하고 넘어감
        print(f"경고: transformers 버전 {transformers.__version__}을(를) 파싱할 수 없어 버전 검증을 건너뜁니다.")
        return

    if current < MIN_TRANSFORMERS_VERSION:
        raise RuntimeError(
            f"Qwen3.5는 transformers >= {'.'.join(map(str, MIN_TRANSFORMERS_VERSION))} 가 필요합니다. "
            f"현재 설치된 버전: {transformers.__version__}. "
            f"`pip install -U transformers` 로 업그레이드하세요."
        )
    print(f"transformers 버전 확인: {transformers.__version__} (요구사항 충족)")


def detect_lora_target_modules(model) -> list[str]:
    """
    LoRA를 적용할 Linear 레이어 이름을 모델에서 직접 찾는다.

    Qwen3.5는 0.8B급 소형 모델은 표준 dense 어텐션(q_proj/k_proj/v_proj/o_proj/
    gate_proj/up_proj/down_proj)을 쓰는 것으로 확인되지만, 대형 MoE 버전(27B/35B 등)은
    Gated Delta Networks 계열의 다른 모듈명(in_proj_qkv, gate_up_proj 등)을 쓴다.
    베이스 모델을 나중에 더 큰 Qwen3.5로 바꾸더라도 이 스크립트가 깨지지 않도록,
    하드코딩된 이름 목록 대신 실제 모델에 존재하는 Linear 레이어 이름을 탐지해서 쓴다.
    """
    candidate_suffixes = [
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj", "gate_up_proj",
        "in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a", "out_proj",
    ]
    vision_keywords = ["vision", "visual", "image_encoder", "patch_merger"]
    found = set()
    for name, module in model.named_modules():
        if not isinstance(module, torch.nn.Linear):
            continue
        # 비전 인코더 하위의 Linear 레이어는 텍스트 파인튜닝 대상에서 제외한다
        # (Qwen3.5는 멀티모달 모델이므로 이 방어가 없으면 비전 프로젝터까지 LoRA가 붙을 수 있다).
        if any(kw in name.lower() for kw in vision_keywords):
            continue
        leaf_name = name.rsplit(".", 1)[-1]
        if leaf_name in candidate_suffixes:
            found.add(leaf_name)

    if not found:
        raise RuntimeError(
            "LoRA를 적용할 Linear 레이어를 모델에서 찾지 못했습니다. "
            "베이스 모델 아키텍처가 예상과 달라졌을 수 있으니, model.named_modules()로 "
            "직접 확인 후 candidate_suffixes를 갱신하세요."
        )
    return sorted(found)


def load_jsonl_as_dataset(path: str) -> Dataset:
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return Dataset.from_list(rows)


def tokenize_function(examples, tokenizer, max_length: int):
    # generate_finetune_data.py가 이미 ChatML 형식("text" 필드)으로 만들어둔 것을 그대로 토큰화한다.
    return tokenizer(
        examples["text"],
        truncation=True,
        max_length=max_length,
        padding="max_length",
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="data/prepared/finetune_data.jsonl")
    parser.add_argument("--base-model", type=str, default="Qwen/Qwen3.5-0.8B-Base")
    parser.add_argument("--checkpoint-dir", type=str, default="checkpoints/lora")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--grad-accum", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--max-length", type=int, default=512)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    args = parser.parse_args()

    check_transformers_version()
    torch.manual_seed(SEED)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device: {device}")
    if device == "cpu":
        print(
            "경고: GPU가 감지되지 않았습니다. LoRA 파인튜닝이라도 CPU에서는 매우 느립니다. "
            "Colab에서 런타임 유형을 GPU로 설정했는지 확인하세요."
        )

    print(f"베이스 모델 로딩: {args.base_model}")
    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16 if device == "cuda" else torch.float32,
        device_map="auto" if device == "cuda" else None,
    )

    # 중요: Qwen3.5는 처음부터 비전-언어(멀티모달) 모델로 설계되었다 (공식 모델 카드에
    # "vision-language model"로 명시됨 — docs/15-stage2-pretrained-finetuning.md 2.1절
    # 재조사 참조). 기본 경로로 로드하면 비전 인코더까지 함께 로드되어 텍스트 전용 CPU
    # 추론에는 불필요한 무게가 더해진다. 로드된 모델에 비전 관련 서브모듈이 있는지 확인해
    # 사용자가 인지하지 못한 채로 무거운 모델을 파인튜닝하는 일이 없도록 한다.
    vision_related_names = [name for name, _ in model.named_modules()
                             if any(kw in name.lower() for kw in ["vision", "visual", "image_encoder", "patch_merger"])]
    if vision_related_names:
        print(
            f"\n경고: 로드된 모델에 비전 관련 서브모듈이 {len(vision_related_names)}개 발견되었습니다 "
            f"(예: {vision_related_names[0]}). Qwen3.5는 멀티모달 모델이라 텍스트 전용 파인튜닝에는 "
            f"불필요한 파라미터가 포함되어 있을 수 있습니다.\n"
            f"text-only로 추출된 체크포인트(예: 커뮤니티가 배포하는 '*-text-only' 저장소)가 "
            f"있는지 확인하고, 있다면 --base-model로 그쪽을 지정하는 것을 권장합니다.\n"
            f"(docs/15-stage2-pretrained-finetuning.md 2.1절 참조)\n"
        )

    # LoRA 설정: 실제 베이스 모델에 존재하는 Linear 레이어를 탐지해서 어댑터를 붙인다
    # (detect_lora_target_modules 참조 — Qwen3.5 버전/크기에 따라 모듈명이 다를 수 있음).
    target_modules = detect_lora_target_modules(model)
    print(f"LoRA 적용 대상 모듈: {target_modules}")

    # 비전 인코더 제외: target_modules는 이름(예: "q_proj")만으로 매칭되므로, 이름이 같은
    # 비전 인코더의 레이어까지 함께 걸릴 수 있다. 실제로 검증한 결과, peft의 exclude_modules는
    # 리스트로 넘기면 리터럴 문자열 매칭만 하고 와일드카드를 지원하지 않는다 — 반드시
    # "정규식 문자열 하나"로 넘겨야 패턴 매칭이 작동한다 (peft.tuners.tuners_utils의
    # check_target_module_exists 구현 확인, 로컬에서 실제 동작 검증 완료).
    if vision_related_names:
        exclude_pattern = r".*(vision|visual|image_encoder|patch_merger).*"
    else:
        exclude_pattern = None

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=target_modules,
        exclude_modules=exclude_pattern,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    print("데이터셋 로딩 및 토큰화")
    dataset = load_jsonl_as_dataset(args.data)
    tokenized = dataset.map(
        lambda ex: tokenize_function(ex, tokenizer, args.max_length),
        batched=True,
        remove_columns=dataset.column_names,
    )

    split = tokenized.train_test_split(test_size=0.1, seed=SEED)
    train_ds, eval_ds = split["train"], split["test"]
    print(f"학습 {len(train_ds)}개, 검증 {len(eval_ds)}개")

    data_collator = DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False)

    training_args = TrainingArguments(
        output_dir=args.checkpoint_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=3,  # 디스크 절약 (Colab 용량 제한 고려)
        load_best_model_at_end=True,
        bf16=(device == "cuda"),
        report_to="none",
        seed=SEED,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=data_collator,
    )

    # 체크포인트 재개: Colab 세션이 끊겨도 이어서 학습 가능 (docs/02-training-pipeline.md 원칙)
    resume = os.path.isdir(args.checkpoint_dir) and any(
        name.startswith("checkpoint-") for name in os.listdir(args.checkpoint_dir)
    )
    trainer.train(resume_from_checkpoint=resume)

    final_dir = os.path.join(args.checkpoint_dir, "final")
    model.save_pretrained(final_dir)
    tokenizer.save_pretrained(final_dir)
    print(f"LoRA 어댑터 저장 완료: {final_dir}")


if __name__ == "__main__":
    main()
