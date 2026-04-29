// index.html에서 사용될 JavaScript 로직
// (예: 스크롤 애니메이션, FAQ 토글, 회원가입/로그인 모달 등)
document.addEventListener('DOMContentLoaded', () => {
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            document.querySelector(this.getAttribute('href')).scrollIntoView({
                behavior: 'smooth'
            });
        });
    });

    // FAQ toggle functionality
    document.querySelectorAll('.faq-item-header').forEach(header => {
        header.addEventListener('click', () => {
            const item = header.closest('.faq-item');
            item.classList.toggle('active');
        });
    });
});
