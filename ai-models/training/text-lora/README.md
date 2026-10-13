# text-lora — Workers AI 텍스트 모델 LoRA 파인튜닝 (3종)

Cloudflare Workers AI에서 LoRA를 지원하는 기반 모델 3개를 파인튜닝해 Workers AI에 올립니다.
`inference-edge` Worker가 `profile`/`mode`에 따라 어댑터를 자동 적용합니다 (어댑터가 없으면 기반 모델로 자동 폴백).

| 프로필 | HF 기반 모델 | Workers AI 모델 | finetune 이름 |
|---|---|---|---|
| quality | google/gemma-7b-it | @cf/google/gemma-7b-it-lora | cp-gemma7b |
| general | mistralai/Mistral-7B-Instruct-v0.2 | @cf/mistral/mistral-7b-instruct-v0.2-lora | cp-mistral7b |
| fast | google/gemma-2b-it | @cf/google/gemma-2b-it-lora | cp-gemma2b |

## 왜 이 3개인가
- Workers AI 카탈로그에서 LoRA 태그가 확인된 기반 모델은 `-lora` 전용 모델뿐입니다. Qwen 3.8, GLM, DeepSeek, Gemma 4 등 최신·대형 모델은 LoRA를 지원하지 않습니다.
- Llama 3.3 70B는 문서에 LoRA 입력 필드가 있으나 카탈로그 LoRA 태그가 확인되지 않았고, 70B는 Colab에서 학습이 사실상 불가능해 제외했습니다. Llama 2 7B는 가장 오래되어 제외했습니다.
- 한국어는 Gemma 토크나이저가 Mistral보다 효율적이라 Gemma 7B를 기본(quality)으로 두었습니다.

## 사용법
`train_text_lora_colab.ipynb`를 Colab에서 위에서부터 실행하세요. 로컬에서는:
```bash
python train_text_lora.py --list
python train_text_lora.py --check-data --data train.jsonl --base google/gemma-2b-it
python train_text_lora.py --base google/gemma-7b-it --data train.jsonl --out out/gemma7b
python train_text_lora.py --validate-only --base google/gemma-7b-it --out out/gemma7b
```

## 학습 데이터
- `sample_sft.jsonl`은 **형식 예시·스모크 테스트용 13개 샘플**입니다. 실제 학습 데이터가 아닙니다.
- 실제 데이터는 직접 보유한 글(블로그 글/제목/요약 등)을 `instruction/output` 쌍으로 만드는 것이 가장 안전합니다.
  공개 데이터셋을 쓸 때는 **각 데이터셋 카드의 라이선스(상업적 이용 가능 여부)를 반드시 확인**하세요.
- 형식: `{"instruction":"...","input":"(선택)","output":"..."}` / `{"prompt":"...","response":"..."}` / `{"messages":[...]}` (단일 턴).
- 학습·추론 프롬프트 형식은 반드시 같아야 합니다: system 지시를 첫 user 메시지 앞에 합칩니다(`SYSTEM_PROMPT`는 `inference-edge/src/ai.ts`와 동일하며 자동 테스트로 일치를 확인).

## Workers AI 요구사항 (스크립트가 자동 검증)
rank ≤ 8(최대 32) · 어댑터 < 300MB · 파일명 `adapter_config.json`/`adapter_model.safetensors` · `model_type`(gemma|mistral|llama) 기록 · 계정당 어댑터 100개 · 업로드 후 수정 불가(새 이름으로 재업로드).

## 주의
- 7B를 T4에서 4비트(QLoRA)로 학습하면 가능하지만, Gemma는 fp16에서 NaN이 날 수 있습니다. L4/A100(bf16) 권장.
- 4비트로 학습한 어댑터를 Cloudflare의 비양자화 기반 모델에 적용하면 품질이 다소 달라질 수 있습니다. 업로드 후 노트북 12번 셀로 실제 응답을 확인하고, 이상하면 `--no-4bit`로 재학습하세요.
- Workers AI의 LoRA는 오픈 베타입니다(문서 기준 베타 기간 무료). 정책·모델 목록은 바뀔 수 있습니다.
