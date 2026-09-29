'use server';

import { revalidatePath } from 'next/cache';
import { dashboardApiContext, getJson, postJson } from '../../../lib/api';

const messages: Record<string, string> = {
  DOMAIN_RENTAL_NAME_INVALID: '이름은 영문·숫자·하이픈 1~63자이며, 처음과 끝은 영문 또는 숫자여야 합니다.',
  DOMAIN_RENTAL_NAME_RESERVED: '운영용으로 예약된 이름입니다. 다른 이름을 입력해 주세요.',
  DOMAIN_RENTAL_NAME_TAKEN: '이미 사용 중인 이름입니다.',
  DOMAIN_RENTAL_QUOTA_EXCEEDED: '대여 가능 개수를 모두 사용했습니다. 기존 주소를 삭제한 뒤 다시 만들어 주세요.',
  DOMAIN_RENTAL_TARGET_INVALID: '연결 주소는 공개된 http:// 또는 https:// 주소여야 합니다. 로그인 정보가 포함된 주소는 사용할 수 없습니다.',
  DOMAIN_RENTAL_REDIRECT_LOOP: '다른 대여 주소로 연결할 수 없습니다. 최종 목적지 주소를 입력해 주세요.',
  DOMAIN_RENTAL_VERSION_CONFLICT: '다른 화면에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.',
  DOMAIN_RENTAL_NOT_FOUND: '주소가 삭제되었거나 관리 권한이 없습니다.',
  DOMAIN_RENTAL_ACCOUNT_UNAVAILABLE: '승인된 계정만 도메인을 대여할 수 있습니다.',
};

export async function mutateRental(operation: 'create' | 'update' | 'delete', id: string | null, input: unknown): Promise<{ ok: boolean; message: string; code?: string }> {
  const context = await dashboardApiContext();
  if (!context.token) return { ok: false, message: '다시 로그인해 주세요.' };
  if (!['create', 'update', 'delete'].includes(operation) || (operation !== 'create' && (typeof id !== 'string' || !id))) return { ok: false, message: '잘못된 요청입니다.' };
  const path = operation === 'create' ? '/domain-rentals' : `/domain-rentals/${encodeURIComponent(id!)}/${operation}`;
  const result = await postJson(path, input, null, context);
  if (!result.ok) return { ok: false, code: result.errorCode, message: messages[result.errorCode || ''] || result.error || '요청을 처리하지 못했습니다.' };
  revalidatePath('/account/domains');
  return { ok: true, message: operation === 'delete' ? '주소를 삭제했습니다.' : '저장했습니다.' };
}

export async function refreshRentals() {
  const context = await dashboardApiContext();
  if (!context.token) return { ok: false, body: null };
  const result = await getJson('/domain-rentals', null, context);
  return { ok: result.ok, body: result.body };
}
