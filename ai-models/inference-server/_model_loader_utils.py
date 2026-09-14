"""
학습 코드(training/flash-texter, training/nano-tech-artist)를 추론 서버에서
안전하게 로드하기 위한 공용 유틸리티.

두 학습 디렉토리는 서로 "model.py", "dataset.py"처럼 같은 파일명을 쓰고,
그 파일들 내부에서는 평범한 절대 import(`from model import ...`)를 사용한다.
평범한 sys.path 조작만으로는 Python의 sys.modules 캐시가 충돌해서
한쪽 모델의 model.py가 다른 쪽 model.py로 잘못 대체되는 문제가 생긴다.

이 유틸리티는 지정된 학습 디렉토리 안의 로컬 모듈들을 미리
고유 접두어를 붙인 이름으로 sys.modules에 강제 등록한 뒤 inference.py를
로드하여, 각 모델의 import가 항상 자기 자신의 파일을 가리키도록 보장한다.
"""
import importlib.util
import os
import sys


def load_inference_module(
    training_dir: str,
    namespace: str,
    local_module_names: list[str],
    entry_filename: str = "inference.py",
):
    """
    training_dir 안의 entry_filename(기본값 inference.py)을 namespace로 격리해서 로드한다.
    local_module_names에 나열된 모듈(예: ["model", "dataset", "tokenizer"])은
    "{namespace}.{name}" 이름으로 먼저 로드되고, entry_filename이 평범하게
    `from model import X`라고 써도 이 격리된 버전을 사용하도록
    sys.modules["model"]을 로드 직전/직후로 감싸서 바꿔치기한다.

    entry_filename을 파라미터화한 이유: 같은 training_dir(예: training/flash-texter)
    안에 단계별로 다른 추론 진입점(inference.py=단계1, inference_stage2.py=단계2)이
    공존할 수 있고, 이 둘은 각각 다른 namespace로 독립적으로 로드되어야 한다.
    """
    cache_key = f"{namespace}.inference"
    if cache_key in sys.modules:
        return sys.modules[cache_key]

    # 1) 로컬 모듈들(model.py, dataset.py, tokenizer.py 등)을 고유 이름으로 로드
    for name in local_module_names:
        path = os.path.join(training_dir, f"{name}.py")
        spec = importlib.util.spec_from_file_location(f"{namespace}.{name}", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"{namespace}.{name}"] = module

    # 2) entry_filename 로드 직전, sys.modules["model"] 등을 이 네임스페이스의 것으로 스왑
    #    (entry_filename 내부의 "from model import X"가 올바른 모듈을 찾도록)
    saved_globals = {name: sys.modules.get(name) for name in local_module_names}
    try:
        for name in local_module_names:
            module = sys.modules[f"{namespace}.{name}"]
            sys.modules[name] = module
            module.__loader__.exec_module(module)  # 실제 내용 실행 (여기서도 상대 import가 격리된 이름을 찾음)

        spec = importlib.util.spec_from_file_location(
            f"{namespace}.inference", os.path.join(training_dir, entry_filename)
        )
        inference_module = importlib.util.module_from_spec(spec)
        sys.modules[cache_key] = inference_module
        spec.loader.exec_module(inference_module)
    finally:
        # 3) 전역 sys.modules["model"] 등을 원래 상태로 복원해 다른 모델 로딩에 영향 없게 함
        for name in local_module_names:
            if saved_globals[name] is not None:
                sys.modules[name] = saved_globals[name]
            else:
                sys.modules.pop(name, None)

    return inference_module
