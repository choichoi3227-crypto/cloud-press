"""
Flash Texter 단계 2 — Colab에서 파인튜닝 완료 후 실행하는 통합 벤치마크 스크립트.
(docs/15-stage2-pretrained-finetuning.md 5절 "완성"의 정의 참조)

이 스크립트가 하는 일:
  1. held-out 검증셋 loss/perplexity를 베이스 모델과 파인튜닝 모델 양쪽에서 측정해 비교
  2. lm-evaluation-harness로 IFEval 실행 (지시 이행 능력, 자동 채점)
  3. eval_prompts.jsonl의 고정 프롬프트에 대한 실제 응답을 생성해 파일로 저장
     (사람이 눈으로 읽고 판단하는 5.3절 정성 평가용 — 이 스크립트는 응답을
     "생성"만 하고 "판정"은 하지 않는다. 판정은 사람 몫이다.)
  4. 결과를 하나의 리포트(JSON + 사람이 읽기 좋은 텍스트)로 정리

이 스크립트는 GPU + huggingface.co 접근이 필요해 로컬 개발 샌드박스에서는
실행 검증이 불가능했다 (docs/15 5.1절 참조). Colab에서 실행한 뒤, 출력된
benchmark_report.json / benchmark_report.txt를 이 저장소 대화에 공유하면
다음 반복(5.4절 루프)의 근거로 사용한다.

사용법 (Colab, 파인튜닝 완료 후):
    python run_benchmarks.py \
        --base-model Qwen/Qwen3.5-0.8B-Base \
        --adapter-dir checkpoints/lora/final \
        --eval-data data/prepared/finetune_data.jsonl \
        --eval-prompts eval_prompts.jsonl \
        --output-dir benchmark_results
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone


def compute_holdout_loss(base_model_path: str, adapter_dir: str | None, eval_data_path: str, max_samples: int = 100):
    """
    held-out 데이터에 대한 평균 loss/perplexity를 계산한다.
    adapter_dir이 None이면 베이스 모델만으로, 있으면 LoRA 어댑터를 적용해서 계산한다.
    """
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(base_model_path)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        base_model_path,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto" if torch.cuda.is_available() else None,
    )

    if adapter_dir:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter_dir)

    model.eval()
    device = next(model.parameters()).device

    rows = []
    with open(eval_data_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    rows = rows[:max_samples]

    total_loss = 0.0
    count = 0
    with torch.no_grad():
        for row in rows:
            inputs = tokenizer(row["text"], return_tensors="pt", truncation=True, max_length=512).to(device)
            outputs = model(**inputs, labels=inputs["input_ids"])
            total_loss += outputs.loss.item()
            count += 1

    avg_loss = total_loss / count if count else float("nan")
    perplexity = torch.exp(torch.tensor(avg_loss)).item() if count else float("nan")
    return {"avg_loss": avg_loss, "perplexity": perplexity, "sample_count": count}


def run_ifeval(model_path: str, adapter_dir: str | None, output_dir: str) -> dict:
    """
    lm-evaluation-harness로 IFEval을 실행한다. peft 어댑터를 쓰는 경우
    model_args에 peft=<adapter_dir>를 전달하는 lm-eval의 표준 방식을 사용한다.
    """
    model_args = f"pretrained={model_path}"
    if adapter_dir:
        model_args += f",peft={adapter_dir}"

    result_path = os.path.join(output_dir, "ifeval_raw")
    cmd = [
        "lm_eval",
        "--model", "hf",
        "--model_args", model_args,
        "--tasks", "ifeval",
        "--device", "cuda:0" if _has_cuda() else "cpu",
        "--batch_size", "auto" if _has_cuda() else "1",
        "--output_path", result_path,
    ]
    print("실행:", " ".join(cmd))
    subprocess.run(cmd, check=True)

    # lm-eval은 --output_path 하위에 결과 json을 저장하지만, 버전에 따라
    # <output_path>/results.json 처럼 바로 두거나, <output_path>/<model_name>/results_*.json
    # 처럼 하위 폴더를 만들기도 한다. 두 경우 모두 대응하도록 재귀적으로 탐색한다.
    found_files = []
    for root, _dirs, files in os.walk(result_path):
        for fname in files:
            if fname.endswith(".json"):
                found_files.append(os.path.join(root, fname))

    if not found_files:
        return {"error": f"lm-eval 결과 파일을 {result_path} 하위에서 찾지 못했습니다. 디렉토리 구조를 직접 확인하세요."}

    # 여러 결과 파일이 있을 수 있으므로(예: 태스크별로 분리), 파일명에 "result"가 포함된
    # 것을 우선하고, 없으면 첫 번째 것을 사용한다.
    result_file = next((f for f in found_files if "result" in os.path.basename(f).lower()), found_files[0])
    print(f"lm-eval 결과 파일 사용: {result_file}")
    with open(result_file, encoding="utf-8") as f:
        return json.load(f)


def _has_cuda() -> bool:
    import torch

    return torch.cuda.is_available()


def generate_qualitative_samples(base_model_path: str, adapter_dir: str, eval_prompts_path: str) -> list[dict]:
    """5.3절 사람 정성 평가용 응답을 생성한다. 판정은 하지 않고 생성만 한다."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    tokenizer = AutoTokenizer.from_pretrained(adapter_dir)
    base = AutoModelForCausalLM.from_pretrained(
        base_model_path,
        torch_dtype=torch.bfloat16 if _has_cuda() else torch.float32,
        device_map="auto" if _has_cuda() else None,
    )
    model = PeftModel.from_pretrained(base, adapter_dir)
    model.eval()
    device = next(model.parameters()).device

    prompts = []
    with open(eval_prompts_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                prompts.append(json.loads(line))

    results = []
    for item in prompts:
        text = (
            "<|im_start|>system\n당신은 Cloud Press가 직접 학습시킨 한국어 대화 모델 "
            "Flash Texter입니다. 친절하고 정확하게 답하세요.<|im_end|>\n"
            f"<|im_start|>user\n{item['prompt']}<|im_end|>\n<|im_start|>assistant\n"
        )
        inputs = tokenizer(text, return_tensors="pt").to(device)
        with torch.no_grad():
            output = model.generate(**inputs, max_new_tokens=300, do_sample=True, temperature=0.7)
        response = tokenizer.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
        results.append({**item, "response": response})

    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", type=str, default="Qwen/Qwen3.5-0.8B-Base")
    parser.add_argument("--adapter-dir", type=str, required=True)
    parser.add_argument("--eval-data", type=str, default="data/prepared/finetune_data.jsonl")
    parser.add_argument("--eval-prompts", type=str, default="eval_prompts.jsonl")
    parser.add_argument("--output-dir", type=str, default="benchmark_results")
    parser.add_argument("--skip-ifeval", action="store_true",
                         help="IFEval은 시간이 오래 걸리므로, 빠른 확인이 필요하면 건너뛸 수 있다")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "base_model": args.base_model,
        "adapter_dir": args.adapter_dir,
    }

    print("=== 1. held-out loss 비교 (베이스 vs 파인튜닝) ===")
    print("베이스 모델 측정 중...")
    report["holdout_loss_base"] = compute_holdout_loss(args.base_model, None, args.eval_data)
    print("파인튜닝 모델 측정 중...")
    report["holdout_loss_finetuned"] = compute_holdout_loss(args.base_model, args.adapter_dir, args.eval_data)

    loss_delta = report["holdout_loss_finetuned"]["avg_loss"] - report["holdout_loss_base"]["avg_loss"]
    report["holdout_loss_delta"] = loss_delta
    print(f"loss 변화: {loss_delta:+.4f} ({'개선' if loss_delta < 0 else '악화'})")

    if not args.skip_ifeval:
        print("\n=== 2. IFEval 실행 (시간이 걸릴 수 있음) ===")
        report["ifeval_base"] = run_ifeval(args.base_model, None, os.path.join(args.output_dir, "ifeval_base"))
        report["ifeval_finetuned"] = run_ifeval(
            args.base_model, args.adapter_dir, os.path.join(args.output_dir, "ifeval_finetuned")
        )
    else:
        print("\n=== 2. IFEval 건너뜀 (--skip-ifeval) ===")

    print("\n=== 3. 정성 평가용 응답 생성 ===")
    qualitative = generate_qualitative_samples(args.base_model, args.adapter_dir, args.eval_prompts)
    report["qualitative_samples"] = qualitative

    report_json_path = os.path.join(args.output_dir, "benchmark_report.json")
    with open(report_json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    report_txt_path = os.path.join(args.output_dir, "benchmark_report.txt")
    with open(report_txt_path, "w", encoding="utf-8") as f:
        f.write(f"Flash Texter 벤치마크 리포트 — {report['timestamp']}\n")
        f.write(f"베이스 모델: {args.base_model}\n")
        f.write(f"어댑터: {args.adapter_dir}\n\n")
        f.write("--- held-out loss ---\n")
        f.write(f"베이스: {report['holdout_loss_base']}\n")
        f.write(f"파인튜닝: {report['holdout_loss_finetuned']}\n")
        f.write(f"변화: {loss_delta:+.4f}\n\n")
        if not args.skip_ifeval:
            f.write("--- IFEval ---\n")
            f.write(f"베이스: {report.get('ifeval_base')}\n")
            f.write(f"파인튜닝: {report.get('ifeval_finetuned')}\n\n")
        f.write("--- 정성 평가용 응답 (사람이 읽고 판단할 것) ---\n\n")
        for item in qualitative:
            f.write(f"[{item['category']}] {item['prompt']}\n")
            f.write(f"-> {item['response']}\n")
            f.write(f"(참고: {item['note']})\n\n")

    print(f"\n리포트 저장 완료: {report_json_path}, {report_txt_path}")
    print("이 파일들을 확인하고, 특히 benchmark_report.txt의 정성 평가 응답을")
    print("직접 읽어보고 판단하세요 (docs/15-stage2-pretrained-finetuning.md 5.3절).")


if __name__ == "__main__":
    main()
