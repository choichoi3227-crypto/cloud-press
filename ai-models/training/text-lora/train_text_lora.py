"""
Cloudflare Workers AI용 텍스트 LoRA 파인튜닝 (Gemma 2B/7B, Mistral 7B).

Workers AI에서 LoRA를 쓸 수 있는 기반 모델은 카탈로그의 "LoRA" 태그 모델뿐이다. 이 스크립트는 그 기반 모델과
같은 가중치(HF)에서 LoRA를 학습해, Workers AI가 요구하는 형식(adapter_config.json + adapter_model.safetensors,
rank ≤ 8, < 300MB, model_type 지정)으로 저장하고 검증한다.

    python train_text_lora.py --list
    python train_text_lora.py --check-data  --data train.jsonl --base google/gemma-2b-it
    python train_text_lora.py --base google/gemma-7b-it --data train.jsonl --out out/gemma7b
    python train_text_lora.py --validate-only --base google/gemma-7b-it --out out/gemma7b

데이터(JSONL, 한 줄에 하나)는 아래 중 어느 형식이든 된다. 단일 턴만 사용한다.
    {"instruction": "...", "input": "(선택)", "output": "..."}
    {"prompt": "...", "response": "..."}
    {"messages": [{"role":"user","content":"..."}, {"role":"assistant","content":"..."}]}

중요: 학습 때 쓰는 프롬프트 형식은 Worker(inference-edge/src/ai.ts)가 추론 때 보내는 형식과 같아야 한다.
Gemma/Mistral 채팅 템플릿에는 system 역할이 없으므로 SYSTEM_PROMPT를 첫 user 메시지 앞에 합친다.
"""
import argparse
import json
import os
import struct
import sys

# ai.ts의 SYSTEM_PROMPT와 글자 하나까지 같아야 한다.
SYSTEM_PROMPT = (
    "You are a helpful assistant for Cloud Press. "
    "Answer clearly and concisely in the same language as the user's message."
)

# HF 기반 모델 → Workers AI 대응 정보
SUPPORTED = {
    "google/gemma-2b-it": {
        "cf_model": "@cf/google/gemma-2b-it-lora", "model_type": "gemma",
        "profile": "fast", "finetune": "cp-gemma2b", "gated": True,
    },
    "google/gemma-7b-it": {
        "cf_model": "@cf/google/gemma-7b-it-lora", "model_type": "gemma",
        "profile": "quality", "finetune": "cp-gemma7b", "gated": True,
    },
    "mistralai/Mistral-7B-Instruct-v0.2": {
        "cf_model": "@cf/mistral/mistral-7b-instruct-v0.2-lora", "model_type": "mistral",
        "profile": "general", "finetune": "cp-mistral7b", "gated": False,
    },
}

MAX_RANK_RECOMMENDED = 8     # 문서: r <= 8 (큰 rank는 32까지)
MAX_RANK_HARD = 32
MAX_ADAPTER_BYTES = 300 * 1024 * 1024
ALLOWED_MODEL_TYPES = {"mistral", "gemma", "llama"}


# ----------------------------------------------------------------------------- 데이터 (torch 불필요)
def to_pair(row: dict):
    """한 줄을 (user_text, assistant_text)로 정규화. 쓸 수 없으면 None."""
    if "messages" in row and isinstance(row["messages"], list):
        user = assistant = None
        for m in row["messages"]:
            if m.get("role") == "user":
                user = m.get("content")
            elif m.get("role") == "assistant" and user is not None:
                assistant = m.get("content")
        pair = (user, assistant)
    elif "instruction" in row:
        user = row["instruction"]
        if row.get("input"):
            user = f"{user}\n\n{row['input']}"
        pair = (user, row.get("output"))
    elif "prompt" in row:
        pair = (row["prompt"], row.get("response") or row.get("completion"))
    else:
        return None
    u, a = pair
    if not isinstance(u, str) or not isinstance(a, str) or not u.strip() or not a.strip():
        return None
    return u.strip(), a.strip()


def load_pairs(path: str, limit: int = 0):
    pairs, skipped = [], 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = to_pair(json.loads(line))
            except json.JSONDecodeError:
                p = None
            if p is None:
                skipped += 1
            else:
                pairs.append(p)
            if limit and len(pairs) >= limit:
                break
    return pairs, skipped


def user_turn(user_text: str) -> str:
    """추론 때 Worker가 보내는 user 메시지와 동일한 내용."""
    return f"{SYSTEM_PROMPT}\n\n{user_text}"


# ----------------------------------------------------------------------------- 어댑터 검증 (torch 불필요)
def read_safetensors_header(path: str) -> dict:
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n <= 0 or n > 100 * 1024 * 1024:
            raise ValueError("safetensors 헤더 크기가 비정상입니다")
        return json.loads(f.read(n))


def validate_adapter(out_dir: str, base: str | None = None):
    """(errors, warnings). errors가 비어 있어야 Workers AI에 올릴 수 있다."""
    errors, warnings = [], []
    cfg_path = os.path.join(out_dir, "adapter_config.json")
    st_path = os.path.join(out_dir, "adapter_model.safetensors")
    for p in (cfg_path, st_path):
        if not os.path.exists(p):
            errors.append(f"필수 파일 없음: {os.path.basename(p)} (이름이 정확히 같아야 합니다)")
    if errors:
        return errors, warnings

    try:
        cfg = json.load(open(cfg_path, encoding="utf-8"))
    except json.JSONDecodeError as e:
        return [f"adapter_config.json 파싱 실패: {e}"], warnings

    if str(cfg.get("peft_type", "")).upper() != "LORA":
        errors.append(f"peft_type이 LORA가 아닙니다: {cfg.get('peft_type')}")
    r = cfg.get("r")
    if not isinstance(r, int):
        errors.append("adapter_config.json에 정수 r(rank)이 없습니다")
    elif r > MAX_RANK_HARD:
        errors.append(f"rank {r} > {MAX_RANK_HARD}: Workers AI는 최대 {MAX_RANK_HARD}까지만 허용합니다")
    elif r > MAX_RANK_RECOMMENDED:
        warnings.append(f"rank {r} > {MAX_RANK_RECOMMENDED}: 문서상 8 이하가 기본이고 최대 32까지 허용됩니다")
    mt = cfg.get("model_type")
    if mt not in ALLOWED_MODEL_TYPES:
        errors.append(f"model_type은 {sorted(ALLOWED_MODEL_TYPES)} 중 하나여야 합니다 (현재: {mt})")
    if base:
        expect = SUPPORTED.get(base)
        if expect and mt != expect["model_type"]:
            errors.append(f"{base}의 model_type은 '{expect['model_type']}'이어야 합니다 (현재: {mt})")
        if cfg.get("base_model_name_or_path") and cfg["base_model_name_or_path"] != base:
            warnings.append(f"base_model_name_or_path가 {cfg['base_model_name_or_path']} 입니다 (기대: {base})")
    if cfg.get("use_dora") or cfg.get("use_rslora"):
        warnings.append("DoRA/rsLoRA는 Workers AI에서 지원 여부가 불확실합니다 — 일반 LoRA 사용을 권장합니다")

    size = os.path.getsize(st_path)
    if size >= MAX_ADAPTER_BYTES:
        errors.append(f"adapter_model.safetensors가 {size/1e6:.0f}MB — 300MB 미만이어야 합니다")

    try:
        header = read_safetensors_header(st_path)
    except Exception as e:  # noqa: BLE001
        errors.append(f"adapter_model.safetensors 헤더를 읽을 수 없습니다: {e}")
        return errors, warnings
    tensors = {k: v for k, v in header.items() if k != "__metadata__"}
    if not tensors:
        errors.append("safetensors에 텐서가 없습니다")
    a_keys = [k for k in tensors if "lora_A" in k]
    b_keys = [k for k in tensors if "lora_B" in k]
    if not a_keys or len(a_keys) != len(b_keys):
        errors.append(f"lora_A/lora_B 쌍이 맞지 않습니다 (A={len(a_keys)}, B={len(b_keys)})")
    if isinstance(r, int):
        bad = [k for k in a_keys if tensors[k]["shape"][0] != r]
        if bad:
            errors.append(f"lora_A의 rank 차원이 config의 r={r}과 다릅니다 (예: {bad[0]})")
    dtypes = {v["dtype"] for v in tensors.values()}
    if not dtypes <= {"F16", "BF16", "F32"}:
        errors.append(f"지원하지 않는 dtype: {sorted(dtypes - {'F16', 'BF16', 'F32'})} (양자화 가중치는 불가)")
    return errors, warnings


# ----------------------------------------------------------------------------- 학습 (torch 필요)
def build_dataset(pairs, tokenizer, max_len: int, model_type: str):
    """프롬프트 토큰은 loss에서 제외(-100)하고 응답 토큰만 학습한다."""
    end = "<end_of_turn>\n" if model_type == "gemma" else (tokenizer.eos_token or "")
    rows, truncated = [], 0
    for user, answer in pairs:
        prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": user_turn(user)}], tokenize=False, add_generation_prompt=True
        )
        p_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
        a_ids = tokenizer(answer + end, add_special_tokens=False)["input_ids"]
        ids = p_ids + a_ids
        labels = [-100] * len(p_ids) + a_ids
        if len(ids) > max_len:
            truncated += 1
            ids, labels = ids[:max_len], labels[:max_len]
        if any(l != -100 for l in labels):
            rows.append({"input_ids": ids, "labels": labels})
    return rows, truncated


def train(args):
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from transformers import (AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, Trainer,
                              TrainingArguments)

    info = SUPPORTED[args.base]
    pairs, skipped = load_pairs(args.data)
    if len(pairs) < 10:
        sys.exit(f"학습 가능한 샘플이 {len(pairs)}개뿐입니다(건너뜀 {skipped}). 데이터를 확인하세요.")
    print(f"샘플 {len(pairs)}개 (형식 오류로 건너뜀 {skipped})")

    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    rows, truncated = build_dataset(pairs, tok, args.max_len, info["model_type"])
    print(f"토큰화 완료 {len(rows)}개, 길이 초과로 잘림 {truncated}개 (max_len={args.max_len})")

    bf16_ok = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16}.get(args.dtype) or (torch.bfloat16 if bf16_ok else torch.float16)
    if info["model_type"] == "gemma" and dtype == torch.float16:
        print("경고: Gemma는 fp16에서 수치가 불안정(NaN)할 수 있습니다. bf16을 지원하는 GPU(L4/A100) 권장.")

    quant = None
    if not args.no_4bit:
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4",
                                   bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=dtype)
    model = AutoModelForCausalLM.from_pretrained(args.base, quantization_config=quant, torch_dtype=dtype, device_map="auto")
    if quant:
        model = prepare_model_for_kbit_training(model)
    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, bias="none",
                      target_modules=["q_proj", "v_proj"], task_type="CAUSAL_LM")
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    def collate(batch):
        m = max(len(b["input_ids"]) for b in batch)
        pad = tok.pad_token_id
        ids = torch.tensor([b["input_ids"] + [pad] * (m - len(b["input_ids"])) for b in batch])
        lab = torch.tensor([b["labels"] + [-100] * (m - len(b["labels"])) for b in batch])
        att = torch.tensor([[1] * len(b["input_ids"]) + [0] * (m - len(b["input_ids"])) for b in batch])
        return {"input_ids": ids, "labels": lab, "attention_mask": att}

    targs = TrainingArguments(
        output_dir=os.path.join(args.out, "_trainer"), per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum, num_train_epochs=args.epochs, max_steps=args.max_steps or -1,
        learning_rate=args.lr, lr_scheduler_type="cosine", warmup_ratio=0.03, logging_steps=10,
        save_strategy="no", report_to="none", fp16=(dtype == torch.float16), bf16=(dtype == torch.bfloat16),
        gradient_checkpointing=True, remove_unused_columns=False, optim="paged_adamw_8bit" if quant else "adamw_torch",
    )
    Trainer(model=model, args=targs, train_dataset=rows, data_collator=collate).train()

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out)
    finalize_adapter(args.out, args.base)


def finalize_adapter(out_dir: str, base: str) -> None:
    """Workers AI 요구사항에 맞게 후처리: model_type 기록, 가중치를 fp16으로 저장."""
    info = SUPPORTED[base]
    cfg_path = os.path.join(out_dir, "adapter_config.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    cfg["model_type"] = info["model_type"]
    json.dump(cfg, open(cfg_path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
    try:
        import torch
        from safetensors.torch import load_file, save_file
        st = os.path.join(out_dir, "adapter_model.safetensors")
        tensors = {k: v.to(torch.float16).contiguous() for k, v in load_file(st).items()}
        save_file(tensors, st, metadata={"format": "pt"})
    except Exception as e:  # noqa: BLE001
        print("fp16 변환 건너뜀:", e)
    errors, warnings = validate_adapter(out_dir, base)
    report(errors, warnings, out_dir, info)


def report(errors, warnings, out_dir, info):
    for w in warnings:
        print("경고:", w)
    if errors:
        print("검증 실패:")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print(f"✅ 검증 통과: {out_dir}")
    print(f"   업로드: npx wrangler ai finetune create {info['cf_model']} {info['finetune']} {out_dir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="지원 모델 목록")
    ap.add_argument("--base", choices=sorted(SUPPORTED))
    ap.add_argument("--data")
    ap.add_argument("--out")
    ap.add_argument("--check-data", action="store_true")
    ap.add_argument("--validate-only", action="store_true")
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--max-steps", type=int, default=0, help="스모크 테스트용(0이면 epochs 사용)")
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--max-len", type=int, default=768)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=16)
    ap.add_argument("--dtype", choices=["auto", "bf16", "fp16"], default="auto")
    ap.add_argument("--no-4bit", action="store_true", help="4비트 양자화 없이 학습(A100급 GPU 필요)")
    args = ap.parse_args()

    if args.list:
        for k, v in SUPPORTED.items():
            print(f"{v['profile']:8s} {k:38s} -> {v['cf_model']}  (finetune 이름: {v['finetune']}, HF 접근 승인: {'필요' if v['gated'] else '불필요'})")
        return
    if not args.base:
        ap.error("--base 필요")
    if args.rank > MAX_RANK_HARD:
        ap.error(f"--rank는 {MAX_RANK_HARD} 이하여야 합니다")
    if args.validate_only:
        errors, warnings = validate_adapter(args.out, args.base)
        return report(errors, warnings, args.out, SUPPORTED[args.base])
    if not args.data:
        ap.error("--data 필요")
    if args.check_data:
        pairs, skipped = load_pairs(args.data)
        print(f"사용 가능 {len(pairs)}개 / 형식 오류 {skipped}개")
        for u, a in pairs[:2]:
            print("--- 예시 ---\n[user]", u[:200], "\n[assistant]", a[:200])
        return
    if not args.out:
        ap.error("--out 필요")
    train(args)


if __name__ == "__main__":
    main()
