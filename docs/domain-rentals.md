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

## 배포 순서

1. 기존 DB 백업 후 정상 배포 절차로 새 Prisma Client를 생성하고 `20260929130000_domain_rentals` 마이그레이션을 **API 교체 전에** 적용한다. `prisma db push`가 아니라 기존 `prisma migrate deploy` 경로를 사용해야 hostname 보호 트리거도 설치된다.
2. API 및 대시보드 이미지를 빌드/배포한다. 관리 기능은 준비되지만 DNS/ingress 설정 없이는 임대 호스트에 접속할 수 없다.
3. 기존 운영 Helm values에 `examples/domain-rentals.values.yaml`을 **추가 overlay**로 적용한다. 기본 chart에 `domainRentals.enabled`가 없거나 false이면 새로운 wildcard ingress를 만들지 않는다. overlay의 `baseDomain`은 API 환경변수에도 같은 값으로 전달된다. 원래 values의 이미지/시크릿/네트워크 설정을 유지한다.
4. `*.raibit.kr` DNS를 기존 Traefik 게이트웨이로 연결하고 wildcard TLS 인증서를 준비한다. `domainRentals.tlsSecret`이 비어 있으면 `ingress.tls.existingSecret`을 재사용하며 인증서가 `*.raibit.kr`을 포함해야 한다. Cloudflare Tunnel 사용 시 wildcard public hostname을 같은 Traefik 원본으로 연결하고 원본 **Host 헤더를 유지**한다. 터널 설정이 `api.raibit.kr`로 Host를 덮으면 동작하지 않는다.
5. 기본 Traefik 우선순위는 기존 hosted-errors fallback(1) < 도메인 대여(2) < 실제 서비스/플랫폼의 명시적 호스트 라우트다. 다른 Ingress 컨트롤러나 우선순위를 커스텀한 환경은 동일한 순서를 별도 확인한다. 외부에서 이미 사용하는 추가 이름은 `domainRentals.reservedNames`에 쉼표로 등록한다.

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
helm template raibitserver infra/helm/raibitserver -f YOUR_EXISTING_VALUES.yaml -f examples/domain-rentals.values.yaml
```

첫 명령은 외부 DB/클라우드 없이 로직·실제 로컬 HTTP·Prisma 어댑터의 계약을 확인한다. PostgreSQL의 실제 잠금/마이그레이션, 전체 Nest/Next 빌드 및 외부 DNS/TLS 확인은 별도 운영 전 검증 대상이다. core `src/server.js` 프로토타입에는 신규 HTTP 경로를 추가하지 않았으며 이 기능의 관리 API는 운영 Nest API가 제공한다.

운영 배포 후 각각 일반/동아리 계정에서 2개/5개와 다음 생성의 409를 확인하고, 테스트 대여 호스트에 `curl -I`로 302·Location·no-store를 확인한다. 목적지 변경, 일시 중지, 삭제 후 재접속도 점검한다. 설정/DB 접근이 실패하면 목적지로 우회하지 않고 실패 응답을 반환한다.
