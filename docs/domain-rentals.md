# 개인 도메인 대여

로그인 후 **계정 메뉴 → 도메인 대여** (`/account/domains`)에서 서버나 프로젝트를 만들지 않고 `이름.raibit.kr`을 대여한다. 주소에 접속하면 저장한 외부 URL로 HTTP **302** 이동하며 브라우저 주소창도 목적지로 바뀐다. DNS CNAME 연결, 역방향 프록시, 외부 사이트 호스팅 기능은 아니다.

## 사용 규칙

- 서버 DB의 현재 `User.accountType`이 `CLUB_MEMBER`이면 계정 전체 **5개**, 그 외는 **2개**다. 관리자 역할이나 조직/프로젝트 개수로 우회하지 않는다. 일시 중지한 주소도 한도를 사용하며 삭제하면 공간이 반환된다.
- 이름은 영문 소문자, 숫자, 하이픈 **1~63자**다. 대문자는 소문자로 정규화하며 시작/끝 하이픈, 점, 와일드카드, 운영용 이름과 생성형 서비스 주소 접두사는 금지한다. 이름을 임의로 잘라 저장하지 않는다.
- 연결 URL은 최대 **4096자**, 절대 `http://` 또는 `https://` URL이다. 입력한 경로·쿼리·fragment를 보존한다. 접속자가 덧붙인 경로·쿼리는 전달하지 않는다. 자격증명 포함 URL, 명백한 내부 주소, 실행형 스킴과 대여 주소끼리의 연결은 차단한다. `apps--...raibit.kr` 같은 플랫폼 앱 주소로의 연결은 가능하다.
- 본인 주소의 목록 조회, 이름/목적지 수정, 일시 중지/재개, 복사, 삭제를 지원한다. 수정·삭제에는 `expectedVersion`이 필요하다. 오래된 화면의 쓰기로 최신 상태를 덮지 않는다.
- 비동아리원으로 변경되면 기존 데이터는 지우지 않고 생성 시각/ID 순서의 앞 2개만 연결한다. 초과 주소는 관리 화면에 표시된다. 정지/승인 취소된 계정의 주소는 연결하지 않는다.
- 수정과 삭제가 브라우저의 영구 리다이렉트 캐시에 묶이지 않도록 모든 대여 응답은 `Cache-Control: no-store`다. CDN에서 이 응답을 강제 캐시하는 규칙을 만들지 않는다. 목적지 URL은 원래 공개 이동 주소이며 비밀 링크 보관함이 아니다.

## API

인증은 기존 Bearer 세션을 사용한다. 개인 계정 기능이므로 조직별 `domain:manage` 권한과 분리한다. 기존 `project:read` 세션 가드 통과 후 코어에서 DB 사용자 승인과 소유권을 다시 확인한다. 사용자가 보내는 owner/accountType 필드는 허용하지 않는다.

| 경로 | 요청 | 결과 |
| --- | --- | --- |
| `GET /api/domain-rentals` | 없음 | baseDomain, limit, used, remaining, rentals |
| `POST /api/domain-rentals` | `{name,targetUrl,enabled?}` | 생성한 주소 (201) |
| `POST /api/domain-rentals/:id/update` | `{expectedVersion,name?,targetUrl?,enabled?}` | 변경한 주소 (200) |
| `POST /api/domain-rentals/:id/delete` | `{expectedVersion}` | `{ok:true}` (200) |

입력 오류 400, 계정 사용 불가 403, 타인/없는 주소 404, 한도·중복·예약·버전 충돌 409다. 공개 대여 호스트의 GET/HEAD는 저장한 주소로 302, 알 수 없거나 중지된 주소는 404, 다른 메서드는 405다. 실제 Host만 사용하며 `X-Forwarded-Host`를 신뢰하지 않는다. 서버에서 목적지에 접속하지 않는다.

## 저장 및 운영

`DomainRental`은 기존 서비스용 `Domain`과 독립적인 PostgreSQL 테이블이다. 계정별 생성/수정/삭제는 **User 행 잠금 → 현재 계정 조회 → 수량 확인 → 변경 → 감사 로그**를 한 트랜잭션으로 실행한다. API가 여러 개여도 같은 사용자의 동시 생성이 한도를 넘지 않는다. 글로벌 hostname unique 인덱스와 두 등록 테이블의 hostname 잠금 트리거가 중복 점유를 차단한다. 감사 로그에는 목적지의 쿼리 토큰을 복사하지 않는다.

기존 `DATABASE_URL`을 이용하는 별도 Prisma 연결 풀을 사용한다. 운영 DB의 연결 예산에 이 풀을 포함한다. 개발 memory 모드에서는 기존 제어 영역의 사용자 정보를 조회하며 프로세스 재시작 시 대여 정보가 사라진다. 운영 기본값은 기존과 동일하게 Prisma다.

## 기존 서버의 자동 업데이트

이미 production Traefik과 wildcard DNS/Tunnel을 사용하는 서버는 **기존 자동 업데이트만으로 적용**된다. `production-values.yaml` 수정, timer 재설치, 수동 Prisma 명령, Cloudflare 토큰 추가가 필요하지 않다. 변경이 병합된 `main`의 정확한 SHA에 대한 CI가 성공하면 기존 updater가 새 chart로 배포한다. PR 상태만으로는 운영 서버가 갱신되지 않는다.

첫 업데이트는 아직 이전 libexec updater로 실행된다. 따라서 자동 활성화와 검증은 새로운 updater 실행을 요구하지 않고 **새 Helm chart 안에서** 처리한다.

1. 기존 updater가 CI 성공 확인, 이미지 빌드·검사·서명과 digest 고정을 수행한다.
2. 기존 `pre-install,pre-upgrade` migration Job이 API 이미지에 포함된 `prisma migrate deploy`를 실행한다. `202609291300_domain_rentals`의 테이블과 hostname 보호 트리거가 API 교체 전에 설치된다. 적용된 migration은 재실행 시 건너뛴다.
3. `domainRentals.enabled: auto`는 production + ingress + Traefik일 때 대여 경로를 자동 생성한다. 기존 설정 파일에 `domainRentals` 항목이 없어도 적용된다. 명시적 `false`는 덮어쓰지 않는다. 로컬/비-Traefik 설치에는 기본적으로 새 wildcard를 만들지 않는다.
4. base domain은 기존 hosted-errors wildcard(미지정 시 `ingress.hosts.public`)에서 가져온다. TLS Secret은 명시적 대여용 Secret → 기존 wildcard용 Secret → 공용 ingress Secret 순으로 재사용한다. 기존 entrypoints·TLS 관련 annotations도 유지한다. 우선순위는 hosted-errors fallback(1) < 대여(2) < 기존 명시적 호스트 경로다. API와 ingress는 같은 base domain을 사용하며 플랫폼 호스트도 예약한다.
5. 새 이미지 배포 뒤 `post-install,post-upgrade` Job이 migration 완료, 테이블·두 충돌 방지 트리거, 생성된 Prisma Client, API health, 관리 API의 비인증 접근 차단, 임의 대여 Host의 DB 조회/404/no-store를 검사한다. 계정·대여 데이터를 만들거나 수정하지 않으며 외부 목적지를 가져오지 않는다.
6. 점검 Job 실패는 Helm upgrade 실패로 전파된다. 기존 Helm 3 `--atomic` / Helm 4 `--rollback-on-failure` 보호와 성공 SHA 기록 순서를 유지한다. 앱/라우팅 rollback과 DB rollback은 다르며 추가된 DB 스키마·데이터를 파괴적으로 되돌리지 않는다.

실패한 점검 Job은 최대 하루 보존되며 코드형 오류만 기록한다. DB URL, JWT, 목적지의 쿼리 토큰은 출력하지 않는다. 점검 Pod는 Kubernetes API 토큰을 받지 않으며 root/privileged/hostPath를 사용하지 않는다. 재시도와 실행 시간에 상한이 있다.

### 기존 edge 설정의 범위

이미 앱 배포에 사용하는 `*.raibit.kr` DNS/Tunnel을 그대로 사용한다. Cloudflare wildcard 규칙은 실제 Host를 보존해야 하고 기존 wildcard 인증서가 해당 도메인을 포함해야 한다. 이 코드는 Cloudflare 계정·DNS 레코드·Tunnel 설정을 새로 만들거나 변경하지 않는다. wildcard가 아직 없는 설치나 별도 base domain까지 자동 연결됐다고 보장하지 않는다. 배포 후 점검은 **클러스터 내부 API·DB**를 확인하며 외부 DNS/TLS의 실접속 증명은 아니다.

일반적인 기존 설치에서는 추가 overlay가 필요하지 않다. 운영자가 기능을 끄거나 별도 domain을 명시적으로 설정할 때만 `examples/domain-rentals.values.yaml`을 참고한다. 별도 도메인을 선택할 때는 `enabled: true`와 해당 DNS/TLS를 준비한다. `auto` 상태에서는 기존 wildcard와 다른 base domain을 거부한다. 외부에서 이미 사용하는 추가 이름은 `domainRentals.reservedNames`에 쉼표로 등록한다.

API를 Helm 밖에서 실행할 때:

```dotenv
RAIBITSERVER_DOMAIN_RENTAL_BASE_DOMAIN=raibit.kr
RAIBITSERVER_DOMAIN_RENTAL_RESERVED_NAMES=school,legacy-service
```

이미 사용 중인 baseDomain은 단순 환경변수 변경만으로 이전되지 않는다. 기존 주소/인증서/DNS를 유지하면서 별도로 이전해야 한다. 삭제한 이름은 즉시 다른 사용자가 대여할 수 있으므로 장기간 공유한 주소를 삭제할 때 주의한다.

## 확인

```sh
node --test tests/domain-rentals.test.js tests/domain-rentals-postgres.test.js
pnpm exec prisma generate --schema prisma/schema.prisma
pnpm typecheck
pnpm test
helm template raibitserver infra/helm/raibitserver -f YOUR_EXISTING_VALUES.yaml
node scripts/check-domain-rentals-helm.mjs
```

첫 명령은 외부 DB/클라우드 없이 로직·실제 로컬 HTTP·Prisma 어댑터의 계약을 확인한다. CI의 PostgreSQL 작업은 기능 추가 전 스키마에서 실제 migration을 실행하고 기존 사용자 보존·2/5개 동시 생성 제한·재시도 및 재연결 후 데이터 보존을 검사한다. Helm 검사는 기존 values만으로 자동 활성화되는 최초 업데이트와 명시적 비활성화·TLS/Host 정합성을 검증한다. 전체 Nest/Next 빌드와 HTTPS 브라우저 검사는 별도 CI 작업에서 실행하고 외부 DNS/TLS는 운영 환경 검증 범위다. core `src/server.js` 프로토타입에는 신규 HTTP 경로를 추가하지 않았으며 이 기능의 관리 API는 운영 Nest API가 제공한다.

운영 배포 후 각각 일반/동아리 계정에서 2개/5개와 다음 생성의 409를 확인하고, 테스트 대여 호스트에 `curl -I`로 302·Location·no-store를 확인한다. 목적지 변경, 일시 중지, 삭제 후 재접속도 점검한다. 설정/DB 접근이 실패하면 목적지로 우회하지 않고 실패 응답을 반환한다.
