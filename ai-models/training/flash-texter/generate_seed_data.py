"""
Flash Texter 단계 1(seq2seq 챗봇)을 위한 소규모 시드 대화 데이터 생성기.

실전에서는 AI Hub 등 공개 대화 코퍼스로 교체/확장하는 것을 권장한다
(docs/02-training-pipeline.md 5절 참조). 이 스크립트는 파이프라인을
처음부터 끝까지 실제로 검증하기 위한 최소 규모(수백~수천 쌍) 시드 데이터를
템플릿 조합으로 생성한다.

사용법:
    python generate_seed_data.py --out data/raw/seed_dialogues.jsonl --repeat 30
"""
import argparse
import json
import random

# (의도, [(입력 템플릿들), (해당 의도에 대한 응답 템플릿들)])
INTENTS = {
    "greeting": {
        "inputs": [
            "안녕", "안녕하세요", "안녕하세요!", "하이", "반가워", "반갑습니다",
            "좋은 아침", "좋은 아침이에요", "안녕 잘 지냈어?", "오랜만이야",
            "안녕하세요 처음 뵙겠습니다", "만나서 반가워요", "처음 뵙네요",
            "안녕하십니까", "hi", "hello", "안녕 반가워", "오랜만이에요",
            "좋은 오후예요", "좋은 저녁이에요", "안녕히 주무셨어요",
        ],
        "responses": [
            "안녕하세요! 무엇을 도와드릴까요?",
            "반갑습니다! 오늘 하루 어떠셨나요?",
            "안녕하세요, 잘 지내고 있어요. 당신은요?",
            "네, 안녕하세요! 궁금한 게 있으면 말씀해 주세요.",
        ],
    },
    "thanks": {
        "inputs": [
            "고마워", "고맙습니다", "감사합니다", "감사해요", "정말 고마워요",
            "도와줘서 고마워", "덕분에 살았어", "땡큐", "정말 고마워 최고야",
            "너무 감사해요", "고마워요 짱이에요", "감사합니다 큰 도움이 됐어요",
            "덕분이에요 고마워요", "고맙습니다 정말로", "너무 고마워",
        ],
        "responses": [
            "천만에요! 도움이 되어서 기뻐요.",
            "별말씀을요, 언제든지 말씀해 주세요.",
            "도움이 되었다니 다행이에요!",
            "네, 필요하면 또 불러주세요.",
        ],
    },
    "weather": {
        "inputs": [
            "오늘 날씨 어때?", "오늘 날씨 어떤가요?", "날씨 알려줘", "밖에 추워?",
            "오늘 비 와?", "오늘 더워?", "요즘 날씨 어때", "지금 비 오는지 궁금해",
            "오늘 눈 와?", "바깥 날씨 어때요", "오늘 우산 필요해?", "날씨가 어떤지 궁금해",
            "지금 밖에 날씨 어때", "오늘 기온이 어떻게 돼",
        ],
        "responses": [
            "죄송해요, 저는 실시간 날씨 정보는 알 수 없어요. 날씨 앱을 확인해 보세요.",
            "실시간 날씨는 확인이 어려워요. 외출 전에 날씨 앱을 확인해 보시는 게 좋을 것 같아요.",
            "제가 날씨를 직접 볼 수는 없지만, 창밖을 한번 확인해 보시겠어요?",
        ],
    },
    "how_are_you": {
        "inputs": [
            "요즘 어때?", "잘 지내?", "어떻게 지내세요?", "기분 어때?", "오늘 컨디션 어때?",
            "잘 지내고 있어?", "요즘 어떻게 지내", "잘 지내고 있니", "오늘 기분이 어떤지 궁금해",
            "몸 상태는 어때", "오늘 하루 어땠어", "지내는 건 어때요",
        ],
        "responses": [
            "저는 항상 준비되어 있어요! 당신은 오늘 어떠셨나요?",
            "잘 지내고 있어요, 물어봐 주셔서 고마워요.",
            "저는 늘 그대로예요. 오늘 무슨 일 있으셨나요?",
        ],
    },
    "farewell": {
        "inputs": [
            "잘가", "안녕히 가세요", "다음에 봐", "또 봐요", "이만 갈게",
            "나중에 얘기하자", "수고했어", "그럼 이만 안녕", "이제 가볼게",
            "다음에 또 얘기해요", "그만 가야겠어요", "잘 있어", "안녕히 계세요",
            "이만 가보겠습니다",
        ],
        "responses": [
            "네, 다음에 또 만나요!",
            "안녕히 가세요, 좋은 하루 보내세요.",
            "네, 언제든 다시 찾아주세요!",
        ],
    },
    "identity": {
        "inputs": [
            "너는 누구야?", "너 누구야", "이름이 뭐야?", "넌 뭐하는 애야?",
            "너는 뭐야?", "자기소개 해줘", "너의 이름은 뭐니", "네 이름이 궁금해",
            "당신은 누구인가요", "너 정체가 뭐야", "너는 어떤 존재야",
            "자기소개 좀 해줄래", "이름 좀 알려줘",
        ],
        "responses": [
            "저는 Flash Texter예요, 여러분과 대화하기 위해 만들어진 챗봇이에요.",
            "저는 Cloud Press의 텍스트 모델, Flash Texter입니다.",
            "저는 대화를 위해 학습된 인공지능 챗봇이에요.",
        ],
    },
    "help": {
        "inputs": [
            "뭐 도와줄 수 있어?", "뭘 할 수 있어?", "너 뭐 할 수 있는데?",
            "사용법 알려줘", "어떻게 쓰는거야", "무엇을 도와줄 수 있나요",
            "네가 할 수 있는 일이 뭐야", "기능이 뭐가 있어", "어떤 도움을 줄 수 있어",
            "사용 방법을 알려줄래",
        ],
        "responses": [
            "지금은 간단한 인사나 일상 대화에 답할 수 있어요. 앞으로 더 많은 걸 할 수 있게 발전할 예정이에요.",
            "아직은 기본적인 대화만 가능하지만, 계속 학습해서 더 똑똑해질 거예요.",
        ],
    },
}


def generate(out_path: str, repeat: int, seed: int = 42) -> None:
    rng = random.Random(seed)
    rows = []
    for intent, data in INTENTS.items():
        inputs = data["inputs"]
        responses = data["responses"]
        for _ in range(repeat):
            inp = rng.choice(inputs)
            resp = rng.choice(responses)
            rows.append({"intent": intent, "input": inp, "response": resp})
    rng.shuffle(rows)

    with open(out_path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"생성 완료: {len(rows)}쌍 -> {out_path}")
    from collections import Counter

    counter = Counter(r["intent"] for r in rows)
    for intent, count in counter.items():
        print(f"  {intent:>15}: {count}쌍")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=str, default="data/raw/seed_dialogues.jsonl")
    parser.add_argument("--repeat", type=int, default=30, help="의도별 반복 샘플링 횟수")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    generate(args.out, args.repeat, args.seed)


if __name__ == "__main__":
    main()
