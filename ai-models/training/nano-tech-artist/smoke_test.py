"""
파이프라인 스모크 테스트 (CPU/GPU 어디서든 약 1~2분).

본 학습을 시작하기 전에 '데이터 생성 → 학습 → 체크포인트 재개 → 엣지 가중치 내보내기 → PyTorch/NumPy 결과 일치'
전 과정이 오류 없이 도는지 작은 규모로 확인한다. 하나라도 실패하면 어느 단계인지 출력하고 종료 코드 1로 끝난다.

    python smoke_test.py            # 기본: CPU
    python smoke_test.py --device cuda
"""
import argparse
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def run(step: str, cmd: list) -> None:
    print(f"\n=== {step} ===\n$ {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=HERE)
    if r.returncode != 0:
        print(f"\n[실패] {step} 단계에서 오류가 났습니다. 위 출력의 마지막 오류 메시지를 확인하세요.")
        sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    a = ap.parse_args()

    py = sys.executable
    with tempfile.TemporaryDirectory() as tmp:
        data, ckpt, edge = os.path.join(tmp, "data"), os.path.join(tmp, "ckpt"), os.path.join(tmp, "edge.bin")

        run("1/5 데이터 생성(240장)", [py, "generate_dataset.py", "--out", data, "--count", "240", "--size", "64"])
        run("2/5 학습 1 epoch", [py, "train.py", "--device", a.device, "--data", data, "--checkpoint-dir", ckpt,
                                  "--epochs", "1", "--batch-size", "16", "--num-workers", "0"])
        run("3/5 체크포인트 재개(2 epoch째)", [py, "train.py", "--device", a.device, "--data", data, "--checkpoint-dir", ckpt,
                                              "--epochs", "2", "--batch-size", "16", "--num-workers", "0"])
        for f in ("latest.pt", "generator_and_disc.pt", "generator_final.pt"):
            if not os.path.exists(os.path.join(ckpt, f)):
                print(f"[실패] 체크포인트 파일이 없습니다: {f}")
                sys.exit(1)
        run("4/5 엣지 가중치 내보내기", [py, "export_edge_weights.py", "--weights", os.path.join(ckpt, "generator_final.pt"),
                                          "--out", edge])

        print("\n=== 5/5 PyTorch vs 엣지(NumPy) 결과 비교 ===")
        import numpy as np
        import torch
        from build_edge_bank import generate, load
        from model import COND_DIM, NOISE_DIM, Generator

        hdr, layers = load(edge)
        gen = Generator()
        gen.load_state_dict(torch.load(os.path.join(ckpt, "generator_final.pt"), map_location="cpu"))
        gen.eval()
        torch.manual_seed(0)
        noise = torch.randn(4, NOISE_DIM)
        cond = torch.zeros(4, COND_DIM)
        for i in range(4):
            cond[i, i % 6] = 1
            cond[i, 6 + i % 3] = 1
        with torch.no_grad():
            ref = gen(noise, cond).numpy()
        out = generate(layers, noise.numpy(), cond.numpy())
        diff = float(np.abs(ref - out).max())
        print(f"최대 오차: {diff:.5f} (0.05 미만이어야 통과)")
        if diff >= 0.05:
            print("[실패] 내보낸 가중치가 원본 모델과 일치하지 않습니다 (export_edge_weights.py 또는 모델 구조 확인).")
            sys.exit(1)

    print("\n✅ 스모크 테스트 통과 — 본 학습을 시작해도 됩니다.")


if __name__ == "__main__":
    main()
