"""
한국어 조사(은/는, 이/가, 을/를, 와/과) 자동 선택 유틸리티.

이 모듈이 존재하는 이유: generate_finetune_data.py가 슬롯 값을 템플릿에 채워 넣을 때
"{topic}은(는)"처럼 항상 두 조사를 병기하는 방식은 학습 데이터에 문법적으로 어색한
문장("복리은(는) ...")을 대량으로 만들어낸다는 것을 실제 생성 결과를 검토하다가
발견했다. 조사는 단어의 마지막 글자에 받침이 있는지에 따라 결정되므로, 이를
자동으로 계산해서 항상 문법적으로 올바른 조사 하나만 붙인다.
"""
import re


def has_final_consonant(word: str) -> bool:
    """
    단어의 마지막 '한글 글자'를 기준으로 받침 유무를 판단한다.
    괄호가 있으면 괄호 앞부분을 기준으로 판단한다
    (예: '탄력성(경제)' -> '탄력성' 기준으로 받침 판단, '탄력성(경제)은'이 맞음).
    한글이 아닌 문자로만 이루어진 경우(숫자, 영문 등)는 받침 없음으로 취급한다
    (완벽하지 않지만, 이 프로젝트의 슬롯 값은 대부분 한글이라 실용적 타협).
    """
    if not word:
        return False

    paren_idx = word.find("(")
    target = word[:paren_idx] if paren_idx > 0 else word

    for ch in reversed(target):
        code = ord(ch)
        if 0xAC00 <= code <= 0xD7A3:  # 완성형 한글 음절 범위
            return (code - 0xAC00) % 28 != 0  # 종성 인덱스가 0이 아니면 받침 있음
    return False


def josa(word: str, with_final: str, without_final: str) -> str:
    """받침 유무에 따라 두 조사 중 올바른 것을 반환한다."""
    return with_final if has_final_consonant(word) else without_final


def eun_neun(word: str) -> str:
    """은/는"""
    return josa(word, "은", "는")


def i_ga(word: str) -> str:
    """이/가"""
    return josa(word, "이", "가")


def eul_reul(word: str) -> str:
    """을/를"""
    return josa(word, "을", "를")


def wa_gwa(word: str) -> str:
    """와/과"""
    return josa(word, "과", "와")


_DUAL_JOSA_PATTERN = re.compile(r"(\S+?)(은\(는\)|이\(가\)|을\(를\)|와\(과\))")

_DUAL_JOSA_RESOLVERS = {
    "은(는)": eun_neun,
    "이(가)": i_ga,
    "을(를)": eul_reul,
    "와(과)": wa_gwa,
}


def resolve_dual_josa(text: str) -> str:
    """
    "{단어}은(는)", "{단어}을(를)" 처럼 두 조사를 병기해 둔 문자열에서, 그 단어의
    받침 유무를 실제로 계산해 올바른 조사 하나만 남긴다.

    generate_finetune_data.py의 슬롯 채우기 이후(단어가 실제 값으로 치환된 뒤) 호출해야
    한다 — "{topic}은(는)"처럼 슬롯이 아직 채워지지 않은 상태에서 호출하면 "{topic"이라는
    글자 기준으로 조사를 계산하게 되어 틀린 결과가 나온다.
    """

    def _replace(match: re.Match) -> str:
        word, dual = match.group(1), match.group(2)
        resolver = _DUAL_JOSA_RESOLVERS[dual]
        return word + resolver(word)

    return _DUAL_JOSA_PATTERN.sub(_replace, text)
