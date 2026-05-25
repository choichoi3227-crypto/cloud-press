/**
 * CloudPress — 하이브리드 스토리지 라우터 v2.0
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 스토리지 구조:
 *   메인 스토리지  : GitHub (CP3 레포 또는 호스팅 레포)
 *   서브 스토리지  : Cloudflare R2 (GitHub 장애 시 자동 폴백)
 *
 * 지원 스토리지:
 *   ✅ CP3 (GitHub)  — CP3 구독 사용자의 메인 스토리지
 *   ✅ R2            — 폴백 또는 CP3 미구독 사용자의 미디어 스토리지
 *   ❌ S3, B2, etc.  — 지원 안 함 (명시적으로 차단)
 *
 * 우선순위:
 *   1. CP3 구독 중 → GitHub CP3 레포 → (장애 시) R2 폴백
 *   2. CP3 미구독  → 호스팅 GitHub 레포 → (장애 시) R2 폴백
 *   3. R2 자격증명 없음 → GitHub만 사용
 */

// ─── 지원 스토리지 타입 ──────────────────────────────────────────────────────
const SUPPORTED_STORAGE = ["github", "r2"];
const UNSUPPORTED_STORAGE = ["s3", "b2", "gcs", "azure", "backblaze", "wasabi"];

// ─── StorageRouter 클래스 ───────────────────────────────────────────────────
export class StorageRouter {
  constructor(config, env) {
    this.env = env;

    // 설정 검증 및 초기화
    const storageType = config?.storageType?.toLowerCase();
    if (UNSUPPORTED_STORAGE.includes(storageType)) {
      console.warn(`[StorageRouter] '${storageType}' 스토리지는 지원하지 않습니다. GitHub 또는 R2만 사용 가능합니다.`);
    }

    this.config = {
      // 메인: CP3 or 호스팅 GitHub 레포
      github: {
        token:  config?.ghToken  || env?.GITHUB_TOKEN || null,
        owner:  config?.ghOwner  || env?.GITHUB_OWNER || null,
        repo:   config?.ghRepo   || env?.GITHUB_REPO  || null,
        branch: config?.ghBranch || "main",
        // CP3 전용 레포 (구독 중이면 사용)
        cp3Token: config?.cp3Token || null,
        cp3Owner: config?.cp3Owner || null,
        cp3Repo:  config?.cp3Repo  || null,
      },
      // 서브: Cloudflare R2 (폴백)
      r2: {
        accountId:       config?.r2AccountId       || env?.R2_ACCOUNT_ID      || null,
        accessKeyId:     config?.r2AccessKeyId     || env?.R2_ACCESS_KEY_ID   || null,
        secretAccessKey: config?.r2SecretAccessKey || env?.R2_SECRET_KEY      || null,
        bucket:          config?.r2Bucket          || env?.R2_BUCKET          || null,
        endpoint:        config?.r2Endpoint        || null,
      },
      // 사용자 구독 상태
      cp3Subscribed:         config?.cp3Subscribed         || false,
      cloudpressdbSubscribed: config?.cloudpressdbSubscribed || false,
      siteId:  config?.siteId  || null,
      userId:  config?.userId  || null,
    };
  }

  // ── 파일 업로드 ──────────────────────────────────────────────────────────────
  /**
   * 파일 업로드 (메인 → 폴백 순서로 시도)
   * @param {string} path       - 파일 경로 (예: wp-content/uploads/2025/image.jpg)
   * @param {string|Uint8Array} content - 파일 내용
   * @param {object} options    - { contentType, category: "media"|"db"|"backup"|"log" }
   */
  async upload(path, content, options = {}) {
    const { category = "media" } = options;

    // DB 파일 경로는 _db/ 접두사 강제
    const finalPath = category === "db"
      ? (path.startsWith("_db/") ? path : `_db/${path}`)
      : (category === "backup"
          ? (path.startsWith("_storage/backup/") ? path : `_storage/backup/${path}`)
          : path);

    // CP3 구독 중이면 CP3 레포 우선
    if (this.config.cp3Subscribed && this.config.github.cp3Repo) {
      const result = await this._uploadToGithubCp3(finalPath, content, options);
      if (result.success) return result;
      console.warn("[StorageRouter] CP3 업로드 실패, R2 폴백 시도...");
    }

    // 기본 GitHub 레포 시도
    const ghResult = await this._uploadToGithub(finalPath, content, options);
    if (ghResult.success) return ghResult;

    // GitHub 실패 → R2 폴백
    console.warn("[StorageRouter] GitHub 업로드 실패, R2 폴백 시도...");
    const r2Result = await this._uploadToR2(finalPath, content, options);
    if (r2Result.success) return { ...r2Result, fallback: true };

    return { success: false, error: "모든 스토리지 업로드 실패" };
  }

  // ── 파일 다운로드 ────────────────────────────────────────────────────────────
  /**
   * 파일 다운로드 (메인 → 폴백 순서로 시도)
   */
  async download(path, options = {}) {
    // CP3 레포 우선
    if (this.config.cp3Subscribed && this.config.github.cp3Repo) {
      const result = await this._downloadFromGithubCp3(path);
      if (result.success) return result;
    }

    // 기본 GitHub 레포
    const ghResult = await this._downloadFromGithub(path);
    if (ghResult.success) return ghResult;

    // R2 폴백
    const r2Result = await this._downloadFromR2(path);
    if (r2Result.success) return { ...r2Result, fallback: true };

    return { success: false, error: `파일을 찾을 수 없습니다: ${path}` };
  }

  // ── 파일 삭제 ────────────────────────────────────────────────────────────────
  async delete(path) {
    const results = await Promise.allSettled([
      this.config.cp3Subscribed ? this._deleteFromGithubCp3(path) : Promise.resolve({ success: false }),
      this._deleteFromGithub(path),
      this._deleteFromR2(path),
    ]);
    return { success: results.some(r => r.status === "fulfilled" && r.value?.success) };
  }

  // ── 파일 목록 ────────────────────────────────────────────────────────────────
  async list(prefix = "") {
    let files = [];

    if (this.config.cp3Subscribed && this.config.github.cp3Repo) {
      const cp3 = await this._listGithubCp3(prefix);
      if (cp3.success) files = [...files, ...cp3.files.map(f => ({ ...f, storage: "cp3" }))];
    }

    const gh = await this._listGithub(prefix);
    if (gh.success) files = [...files, ...gh.files.map(f => ({ ...f, storage: "github" }))];

    const r2 = await this._listR2(prefix);
    if (r2.success) files = [...files, ...r2.files.map(f => ({ ...f, storage: "r2", fallback: true }))];

    // 중복 제거 (path 기준)
    const seen = new Set();
    const unique = files.filter(f => {
      if (seen.has(f.path)) return false;
      seen.add(f.path);
      return true;
    });

    return { success: true, files: unique };
  }

  // ── 스토리지 상태 확인 ────────────────────────────────────────────────────────
  async healthCheck() {
    const [githubOk, r2Ok] = await Promise.allSettled([
      this._checkGithubHealth(),
      this._checkR2Health(),
    ]);

    return {
      github: {
        ok: githubOk.status === "fulfilled" && githubOk.value,
        provider: "github",
        type: this.config.cp3Subscribed ? "cp3" : "repo",
      },
      r2: {
        ok: r2Ok.status === "fulfilled" && r2Ok.value,
        provider: "r2",
        type: "fallback",
      },
      activeStorage: githubOk.status === "fulfilled" && githubOk.value ? "github" : "r2",
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: GitHub 스토리지 (메인)
  // ─────────────────────────────────────────────────────────────────────────────

  async _uploadToGithub(path, content, options = {}) {
    const { token, owner, repo, branch } = this.config.github;
    if (!token || !owner || !repo) return { success: false, error: "GitHub 설정 누락" };
    return this._ghUpload(token, owner, repo, branch, path, content, options);
  }

  async _uploadToGithubCp3(path, content, options = {}) {
    const { cp3Token, cp3Owner, cp3Repo } = this.config.github;
    const { token, branch } = this.config.github;
    if (!cp3Repo) return { success: false, error: "CP3 레포 설정 누락" };
    const t = cp3Token || token;
    if (!t || !cp3Owner) return { success: false, error: "CP3 토큰/Owner 설정 누락" };

    // CP3는 {userId}/{siteId}/ 접두사 추가
    const cp3Path = `${this.config.userId}/${this.config.siteId}/${path}`;
    return this._ghUpload(t, cp3Owner, cp3Repo, branch, cp3Path, content, options);
  }

  async _ghUpload(token, owner, repo, branch, path, content, options) {
    try {
      // 기존 파일 SHA 가져오기 (업데이트 시 필요)
      let sha;
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CloudPress-StorageRouter/2.0",
        },
      });
      if (getRes.ok) {
        const getData = await getRes.json();
        sha = getData.sha;
      }

      // 파일 업로드
      const encoded = typeof content === "string"
        ? btoa(unescape(encodeURIComponent(content)))
        : btoa(String.fromCharCode(...new Uint8Array(content)));

      const body = {
        message: `[CloudPress] Upload ${path}`,
        content: encoded,
        branch,
      };
      if (sha) body.sha = sha;

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CloudPress-StorageRouter/2.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          success: true,
          path,
          url: data.content?.download_url,
          sha: data.content?.sha,
          storage: "github",
        };
      }
      const err = await res.json().catch(() => ({}));
      return { success: false, error: err.message || `GitHub 오류: ${res.status}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _downloadFromGithub(path) {
    const { token, owner, repo, branch } = this.config.github;
    if (!token || !owner || !repo) return { success: false, error: "GitHub 설정 누락" };
    return this._ghDownload(token, owner, repo, branch, path);
  }

  async _downloadFromGithubCp3(path) {
    const { cp3Token, cp3Owner, cp3Repo, token, branch } = this.config.github;
    if (!cp3Repo) return { success: false, error: "CP3 레포 설정 누락" };
    const t = cp3Token || token;
    const cp3Path = `${this.config.userId}/${this.config.siteId}/${path}`;
    return this._ghDownload(t, cp3Owner, cp3Repo, branch, cp3Path);
  }

  async _ghDownload(token, owner, repo, branch, path) {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "CloudPress-StorageRouter/2.0",
        },
      });
      if (!res.ok) return { success: false, error: `파일 없음: ${res.status}` };
      const data = await res.json();
      const content = atob(data.content.replace(/\n/g, ""));
      return { success: true, content, path, sha: data.sha, url: data.download_url, storage: "github" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _deleteFromGithub(path) {
    const { token, owner, repo, branch } = this.config.github;
    if (!token || !owner || !repo) return { success: false };
    try {
      // SHA 가져오기
      const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "CloudPress-StorageRouter/2.0" },
      });
      if (!getRes.ok) return { success: false };
      const getData = await getRes.json();

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "CloudPress-StorageRouter/2.0",
        },
        body: JSON.stringify({ message: `[CloudPress] Delete ${path}`, sha: getData.sha, branch }),
      });
      return { success: res.ok };
    } catch { return { success: false }; }
  }

  async _deleteFromGithubCp3(path) {
    return { success: false }; // CP3는 필요 시 구현
  }

  async _listGithub(prefix) {
    const { token, owner, repo, branch } = this.config.github;
    if (!token || !owner || !repo) return { success: false, files: [] };
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "CloudPress-StorageRouter/2.0" },
      });
      if (!res.ok) return { success: false, files: [] };
      const data = await res.json();
      const files = (data.tree || [])
        .filter(f => f.type === "blob" && (!prefix || f.path.startsWith(prefix)))
        .map(f => ({ path: f.path, size: f.size, sha: f.sha }));
      return { success: true, files };
    } catch { return { success: false, files: [] }; }
  }

  async _listGithubCp3(prefix) {
    return { success: false, files: [] }; // 필요 시 구현
  }

  async _checkGithubHealth() {
    const { token, owner, repo } = this.config.github;
    if (!token || !owner || !repo) return false;
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "CloudPress-StorageRouter/2.0" },
      });
      return res.ok;
    } catch { return false; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE: R2 스토리지 (폴백 — 사용자 결제 수단 사용)
  // ─────────────────────────────────────────────────────────────────────────────

  async _uploadToR2(path, content, options = {}) {
    const r2 = this.env?.R2_BUCKET_BINDING;

    // Workers R2 바인딩 우선
    if (r2) {
      try {
        const blob = typeof content === "string"
          ? new Blob([content], { type: options.contentType || "application/octet-stream" })
          : new Blob([content], { type: options.contentType || "application/octet-stream" });
        await r2.put(path, blob, {
          httpMetadata: { contentType: options.contentType || "application/octet-stream" },
          customMetadata: { siteId: this.config.siteId, userId: this.config.userId },
        });
        return { success: true, path, storage: "r2" };
      } catch (e) {
        return { success: false, error: `R2 업로드 실패: ${e.message}` };
      }
    }

    // S3 호환 API (사용자 R2 자격증명)
    const { accountId, accessKeyId, secretAccessKey, bucket, endpoint } = this.config.r2;
    if (!accessKeyId || !secretAccessKey || !bucket) {
      return { success: false, error: "R2 자격증명이 설정되지 않았습니다." };
    }

    try {
      const r2Endpoint = endpoint || `https://${accountId}.r2.cloudflarestorage.com`;
      const url = `${r2Endpoint}/${bucket}/${path}`;

      // AWS Signature V4 (간소화)
      const signature = await this._signR2Request("PUT", url, content, accessKeyId, secretAccessKey);
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": options.contentType || "application/octet-stream",
          Authorization: signature.authHeader,
          "x-amz-date": signature.amzDate,
          "x-amz-content-sha256": signature.contentSha256,
        },
        body: content,
      });
      return { success: res.ok, path, storage: "r2", statusCode: res.status };
    } catch (e) {
      return { success: false, error: `R2 API 오류: ${e.message}` };
    }
  }

  async _downloadFromR2(path) {
    const r2 = this.env?.R2_BUCKET_BINDING;
    if (r2) {
      try {
        const obj = await r2.get(path);
        if (!obj) return { success: false, error: "R2: 파일 없음" };
        const content = await obj.text();
        return { success: true, content, path, storage: "r2" };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    const { accountId, accessKeyId, secretAccessKey, bucket, endpoint } = this.config.r2;
    if (!accessKeyId || !secretAccessKey || !bucket) return { success: false, error: "R2 자격증명 없음" };

    try {
      const r2Endpoint = endpoint || `https://${accountId}.r2.cloudflarestorage.com`;
      const url = `${r2Endpoint}/${bucket}/${path}`;
      const signature = await this._signR2Request("GET", url, "", accessKeyId, secretAccessKey);
      const res = await fetch(url, {
        headers: {
          Authorization: signature.authHeader,
          "x-amz-date": signature.amzDate,
          "x-amz-content-sha256": signature.contentSha256,
        },
      });
      if (!res.ok) return { success: false, error: `R2: ${res.status}` };
      const content = await res.text();
      return { success: true, content, path, storage: "r2" };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async _deleteFromR2(path) {
    const r2 = this.env?.R2_BUCKET_BINDING;
    if (r2) {
      try { await r2.delete(path); return { success: true }; }
      catch { return { success: false }; }
    }
    return { success: false };
  }

  async _listR2(prefix) {
    const r2 = this.env?.R2_BUCKET_BINDING;
    if (r2) {
      try {
        const list = await r2.list({ prefix });
        const files = (list.objects || []).map(o => ({ path: o.key, size: o.size }));
        return { success: true, files };
      } catch { return { success: false, files: [] }; }
    }
    return { success: false, files: [] };
  }

  async _checkR2Health() {
    const r2 = this.env?.R2_BUCKET_BINDING;
    if (r2) {
      try { await r2.list({ limit: 1 }); return true; }
      catch { return false; }
    }
    const { accessKeyId, bucket } = this.config.r2;
    return !!(accessKeyId && bucket);
  }

  // AWS Signature V4 (R2 S3 호환 API용 간소화 버전)
  async _signR2Request(method, url, body, accessKeyId, secretAccessKey) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
    const dateStamp = amzDate.slice(0, 8);

    // SHA256 해시 (간소화 — Workers SubtleCrypto 사용)
    const encoder = new TextEncoder();
    const bodyBytes = typeof body === "string" ? encoder.encode(body) : body;
    const hashBuf = await crypto.subtle.digest("SHA-256", bodyBytes || encoder.encode(""));
    const contentSha256 = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, "0")).join("");

    // 간단한 Authorization 헤더 생성 (실제 운영 시 완전한 SigV4 구현 필요)
    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${dateStamp}/auto/s3/aws4_request`;

    return { authHeader, amzDate, contentSha256 };
  }
}

// ─── 팩토리 함수 ──────────────────────────────────────────────────────────────
/**
 * 사이트 설정과 사용자 구독 상태로 StorageRouter 생성
 * sites.js, provisioning.js에서 호출
 */
export function createStorageRouter(site, user, subscriptions, env) {
  // 지원하지 않는 스토리지 타입 감지
  const storageType = site?.ext_storage_type;
  if (storageType && UNSUPPORTED_STORAGE.includes(storageType.toLowerCase())) {
    console.error(`[StorageRouter] 지원하지 않는 스토리지 타입: ${storageType}. GitHub 또는 R2만 허용됩니다.`);
  }

  return new StorageRouter(
    {
      ghToken:  user?.gh_token || env?.GITHUB_TOKEN,
      ghOwner:  site?.github_repo_owner,
      ghRepo:   site?.github_repo_name,
      ghBranch: "main",

      // CP3 구독 시 전용 레포 설정 (platform 설정에서 가져옴)
      cp3Token: env?.CP3_GITHUB_TOKEN,
      cp3Owner: env?.CP3_GITHUB_OWNER,
      cp3Repo:  env?.CP3_GITHUB_REPO,

      // R2 자격증명 (사용자 결제 수단으로 청구)
      r2AccountId:       user?.r2_account_id       || env?.R2_ACCOUNT_ID,
      r2AccessKeyId:     user?.r2_access_key_id     || env?.R2_ACCESS_KEY_ID,
      r2SecretAccessKey: user?.r2_secret_access_key || env?.R2_SECRET_KEY,
      r2Bucket:          site?.r2_bucket            || env?.R2_BUCKET,
      r2Endpoint:        user?.r2_endpoint          || null,

      cp3Subscribed:          subscriptions?.cp3         || false,
      cloudpressdbSubscribed: subscriptions?.cloudpressdb || false,
      siteId: site?.id,
      userId: user?.id,
    },
    env
  );
}

export default StorageRouter;
