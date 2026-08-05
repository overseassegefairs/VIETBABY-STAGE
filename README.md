# VIETBABY & VIETEDU 2026 — Stage Schedule Site

Claude 아티팩트에서 만든 스테이지 스케줄 + 신청서 사이트를, 실제 도메인에 배포할 수 있는 독립 프로젝트로 옮긴 버전입니다.

원래 아티팩트는 `window.storage`라는 Claude 전용 저장소를 썼는데, 이건 claude.ai 밖에서는 동작하지 않아요.
그래서 이 프로젝트는 **Supabase**(무료 클라우드 데이터베이스)로 그 저장소를 대체했습니다. `src/App.jsx`는 이전 아티팩트 코드와 완전히 동일하고, `src/storage.js`가 `window.storage`를 Supabase로 연결해주는 역할만 합니다.

---

## 1. Supabase 프로젝트 만들기 (5분)

1. https://supabase.com 접속 → 무료 계정 생성 → **New project** 클릭
2. 프로젝트 이름, DB 비밀번호(아무거나, 나중에 안 씀), 리전은 **Southeast Asia (Singapore)** 추천 (베트남/한국과 가까움)
3. 프로젝트 생성 후 좌측 메뉴 **SQL Editor** 클릭 → 아래 SQL을 붙여넣고 **Run**

```sql
create table kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- 이 프로젝트는 앱 자체 접속 코드로만 관리자 기능을 보호하고 있어서,
-- 별도 로그인 시스템 없이 anon key로 자유롭게 읽고 쓸 수 있게 열어둡니다.
alter table kv_store enable row level security;

create policy "public read" on kv_store
  for select using (true);

create policy "public write" on kv_store
  for insert with check (true);

create policy "public update" on kv_store
  for update using (true);

create policy "public delete" on kv_store
  for delete using (true);
```

4. 좌측 메뉴 **Project Settings → API** 로 이동 → 아래 두 값을 복사해둡니다.
   - **Project URL** (예: `https://abcdefgh.supabase.co`)
   - **anon public** key (긴 문자열)

> ⚠️ 참고: 이 anon key는 브라우저에 노출되는 공개 키라서, 이 설정대로면 URL만 알면 누구나 데이터를 읽고 쓸 수 있어요. 지금 사이트도 원래 관리자 코드가 브라우저 코드에 들어있는 수준의 보안이라(진짜 로그인 아님), 이 정도가 자연스러운 선을 맞춘 겁니다. 더 강한 보안이 필요하면 마지막 섹션을 참고하세요.

---

## 2. 로컬에서 실행해보기

```bash
cd vietbaby-site
npm install
cp .env.example .env
```

`.env` 파일을 열어서 방금 복사한 값 두 개를 넣어주세요.

```
VITE_SUPABASE_URL=https://abcdefgh.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
```

```bash
npm run dev
```

브라우저에서 `http://localhost:5173` 열어서 잘 뜨는지, 신청서 제출/관리자 페이지가 잘 동작하는지 확인하세요.

---

## 3. GitHub에 올리기

```bash
cd vietbaby-site
git init
git add .
git commit -m "Initial commit"
```

GitHub에서 새 저장소(repository)를 만들고, 안내된 명령어로 push 하세요. (`.env`는 `.gitignore`에 있어서 안 올라갑니다 — 안전합니다.)

---

## 4. Vercel로 배포하기

1. https://vercel.com 접속 → GitHub 계정으로 로그인
2. **Add New → Project** → 방금 만든 GitHub 저장소 선택 → **Import**
3. Framework Preset은 자동으로 **Vite**가 잡힙니다. 그대로 두세요.
4. **Environment Variables**에 아래 두 개를 추가:
   - `VITE_SUPABASE_URL` = Supabase Project URL
   - `VITE_SUPABASE_ANON_KEY` = Supabase anon public key
5. **Deploy** 클릭 → 1~2분 후 `https://프로젝트명.vercel.app` 주소로 사이트가 뜹니다.

(Netlify를 쓰고 싶으면: Build command `npm run build`, Publish directory `dist`, 같은 환경변수 두 개 설정하면 동일하게 동작해요.)

---

## 5. 우리 도메인 연결하기

1. Vercel 프로젝트 → **Settings → Domains** → 원하는 도메인(예: `stage.vietbaby2026.com`) 입력
2. Vercel이 알려주는 CNAME(또는 A) 레코드를 도메인을 구매한 곳(가비아, Cloudflare, GoDaddy 등)의 DNS 설정에 추가
3. 보통 몇 분~몇 시간 내로 반영되고, Vercel이 자동으로 SSL 인증서(https)도 붙여줍니다.

---

## 접속 코드 관련 참고사항

사이트 안에서 관리자 페이지 → 설정 탭에서 접속 코드를 바꿀 수 있는데, 이건 Supabase의 `kv_store` 테이블에 저장돼요. 최초 기본 코드는 `vietbaby2026`입니다.

이 방식은 여전히 "누구나 코드를 알면 들어올 수 있는" 수준의 보안이에요(진짜 로그인 시스템이 아님). 트레이드쇼 운영 목적으로는 보통 충분하지만, 만약 실제 로그인/권한 관리(누가 접속했는지 기록, 비밀번호 찾기 등)가 필요해지면 Supabase Auth를 붙이는 별도 작업이 필요해요 — 필요하시면 말씀해주세요.

---

## 파일 구조

```
vietbaby-site/
├── index.html
├── package.json
├── vite.config.js
├── .env.example        # 실제 값 넣어서 .env로 복사해 쓰세요
├── src/
│   ├── main.jsx         # 진입점 (storage.js를 먼저 불러옴)
│   ├── storage.js        # window.storage → Supabase 연결 어댑터
│   └── App.jsx            # 사이트 전체 코드 (아티팩트와 동일)
└── README.md (이 파일)
```
