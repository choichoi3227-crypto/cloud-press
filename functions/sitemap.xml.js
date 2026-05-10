export async function onRequest(context) {
  // 1. 동적 데이터 가져오기 (예: 외부 API나 Cloudflare KV, D1 DB 등)
  // 여기서는 예시로 고정된 리스트를 사용하지만, fetch()를 통해 외부 데이터를 가져올 수 있습니다.
  const posts = [
    { slug: 'hello-world', date: '2023-10-27' },
    { slug: 'cloudflare-pages-guide', date: '2023-10-28' },
  ];

  const baseUrl = "https://cloud-press.co.kr";

  // 2. XML 생성
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>${baseUrl}/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
      </url>
      ${posts.map(post => `
        <url>
          <loc>${baseUrl}/posts/${post.slug}</loc>
          <lastmod>${post.date}</lastmod>
          <changefreq>weekly</changefreq>
          <priority>0.8</priority>
        </url>
      `).join('')}
    </urlset>`.trim();

  // 3. 응답 반환 (Content-Type 설정이 중요합니다)
  return new Response(sitemap, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600", // 1시간 캐싱 권장
    },
  });
}
